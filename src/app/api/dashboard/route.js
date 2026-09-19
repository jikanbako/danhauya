export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import Requisition from "@/models/Requisition";
import Approval from "@/models/Approval";
import User from "@/models/User";
import { REQUISITION_STATUS, APPROVAL_ACTIONS } from "@/constants/requisitionOptions";
import { ROLES, APPROVER_ROLES } from "@/constants/roles";

function getAuth() {
  const token = cookies().get("token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET() {
  try {
    const auth = getAuth();
    if (!auth) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

    await connectDB();

    if (auth.role === ROLES.REQUESTER) {
      const requesterFilter = { requester: auth.sub };
      const [draftCount, pendingCount, returnedCount, approvedCount, rejectedCount, totalCount] = await Promise.all([
        Requisition.countDocuments({ ...requesterFilter, status: REQUISITION_STATUS.DRAFT }),
        Requisition.countDocuments({ ...requesterFilter, status: REQUISITION_STATUS.PENDING }),
        Requisition.countDocuments({ ...requesterFilter, status: REQUISITION_STATUS.RETURNED }),
        Requisition.countDocuments({ ...requesterFilter, status: REQUISITION_STATUS.APPROVED }),
        Requisition.countDocuments({ ...requesterFilter, status: REQUISITION_STATUS.REJECTED }),
        Requisition.countDocuments(requesterFilter),
      ]);
      return NextResponse.json({ role: auth.role, draftCount, pendingCount, returnedCount, approvedCount, rejectedCount, totalCount });
    }

    if (APPROVER_ROLES.includes(auth.role)) {
      const possiblePending = await Requisition.find({
        status: { $in: [REQUISITION_STATUS.PENDING, REQUISITION_STATUS.RETURNED] },
        awaitingRequesterAction: { $ne: true },
        "approvalChain.approver": auth.sub,
      }).select("_id currentStepIndex approvalChain status awaitingRequesterAction").lean();

      const pendingMyStep = possiblePending.filter((requisition) => {
        const currentStep = requisition.approvalChain?.[requisition.currentStepIndex];
        return currentStep && String(currentStep.approver) === String(auth.sub) && currentStep.type === "approval";
      }).length;

      const [approvedByMe, returnedByMe, rejectedByMe, reviewedByMe] = await Promise.all([
        Approval.countDocuments({ approver: auth.sub, action: APPROVAL_ACTIONS.APPROVE }),
        Approval.countDocuments({ approver: auth.sub, action: APPROVAL_ACTIONS.RETURN }),
        Approval.countDocuments({ approver: auth.sub, action: APPROVAL_ACTIONS.REJECT }),
        Approval.countDocuments({ approver: auth.sub }),
      ]);

      return NextResponse.json({ role: auth.role, pendingMyStep, approvedByMe, returnedByMe, rejectedByMe, reviewedByMe });
    }

    if (auth.role === ROLES.PROCUREMENT) {
      // Procurement has two distinct appearances in the workflow:
      // 1. Market Survey before VC approval.
      // 2. Processing after VC approval.
      const possible = await Requisition.find({
        status: { $in: [REQUISITION_STATUS.PENDING, REQUISITION_STATUS.RETURNED, REQUISITION_STATUS.APPROVED] },
        awaitingRequesterAction: { $ne: true },
        "approvalChain.approver": auth.sub,
      }).select("_id currentStepIndex approvalChain status procurementStatus procurementOfficer").lean();

      let marketSurveyCount = 0;
      let processingCount = 0;
      let readyForProcurement = 0;
      let completedCount = 0;
      let awaitingVcCount = 0;

      for (const requisition of possible) {
        const step = requisition.approvalChain?.[requisition.currentStepIndex];
        const assignedToMe = String(requisition.procurementOfficer || "") === String(auth.sub);
        const stepAssignedToMe = step && String(step.approver) === String(auth.sub);

        if (stepAssignedToMe && step.type === "procurement_review" && requisition.status === REQUISITION_STATUS.PENDING) {
          marketSurveyCount += 1;
        }

        if (assignedToMe && requisition.procurementStatus === "submitted_to_vc") {
          awaitingVcCount += 1;
        }

        if (assignedToMe && requisition.status === REQUISITION_STATUS.APPROVED && requisition.procurementStatus === "ready") {
          readyForProcurement += 1;
        }

        if (assignedToMe && requisition.status === REQUISITION_STATUS.APPROVED && requisition.procurementStatus === "processing") {
          processingCount += 1;
        }

        if (assignedToMe && requisition.status === REQUISITION_STATUS.APPROVED && requisition.procurementStatus === "completed") {
          completedCount += 1;
        }
      }

      return NextResponse.json({
        role: auth.role,
        marketSurveyCount,
        awaitingVcCount,
        readyForProcurement,
        processingCount,
        completedCount,
        totalProcurementItems: readyForProcurement + processingCount + completedCount,
      });
    }

    if (auth.role === ROLES.ADMIN) {
      const [totalUsers, pendingUsers, activeUsers, deactivatedUsers, totalRequisitions, activeRequisitions, draftRequisitions, pendingRequisitions, returnedRequisitions, approvedRequisitions, rejectedRequisitions] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ accountStatus: "pending" }),
        User.countDocuments({ accountStatus: "active" }),
        User.countDocuments({ accountStatus: "deactivated" }),
        Requisition.countDocuments(),
        Requisition.countDocuments({ status: { $in: [REQUISITION_STATUS.PENDING, REQUISITION_STATUS.RETURNED] } }),
        Requisition.countDocuments({ status: REQUISITION_STATUS.DRAFT }),
        Requisition.countDocuments({ status: REQUISITION_STATUS.PENDING }),
        Requisition.countDocuments({ status: REQUISITION_STATUS.RETURNED }),
        Requisition.countDocuments({ status: REQUISITION_STATUS.APPROVED }),
        Requisition.countDocuments({ status: REQUISITION_STATUS.REJECTED }),
      ]);
      return NextResponse.json({ role: auth.role, totalUsers, pendingUsers, activeUsers, deactivatedUsers, totalRequisitions, activeRequisitions, draftRequisitions, pendingRequisitions, returnedRequisitions, approvedRequisitions, rejectedRequisitions });
    }

    return NextResponse.json({ message: "No dashboard statistics are configured for this role." }, { status: 403 });
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json({ message: error.message || "Failed to load dashboard statistics." }, { status: 500 });
  }
}
