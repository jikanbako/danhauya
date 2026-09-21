import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import Requisition from "@/models/Requisition";
import Approval from "@/models/Approval";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";
import { APPROVER_ROLES, ROLES } from "@/constants/roles";
import { PROCUREMENT_POSITIONS } from "@/constants/procurement";

function getAuth() {
  const token = cookies().get("token")?.value;
  return token ? verifyToken(token) : null;
}

export async function GET(request) {
  const auth = getAuth();
  if (!auth) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const stage = searchParams.get("stage") || "current";

  const queueRoles = [...APPROVER_ROLES, ROLES.PROCUREMENT];
  if (!queueRoles.includes(auth.role)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  await connectDB();

  /*
   * Historical decisions are stored in Approval records. This is deliberately
   * separate from the current queue so a decision remains discoverable even
   * after another officer/approver has moved the requisition forward.
   */
  if (stage === "my-decisions") {
    const action = searchParams.get("action");
    const allowedActions = ["approve", "return", "reject"];

    const query = {
      approver: auth.sub,
      ...(allowedActions.includes(action) ? { action } : {}),
    };

    const decisions = await Approval.find(query)
      .sort({ createdAt: -1 })
      .populate({
        path: "requisition",
        populate: {
          path: "requester",
          select: "fullName email role collegeId facultyId department",
        },
      })
      .lean();

    const seen = new Set();
    const requisitions = decisions
      .map((decision) => ({
        ...decision.requisition,
        myDecision: decision.action,
        myDecisionComment: decision.comment,
        myDecisionAt: decision.createdAt,
        myDecisionStepIndex: decision.stepIndex,
      }))
      .filter((requisition) => {
        if (!requisition?._id) return false;
        const key = String(requisition._id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    return NextResponse.json({
      requisitions,
      stage,
      action: action || "all",
    });
  }

  const base = {
    awaitingRequesterAction: { $ne: true },
    consolidatedInto: { $exists: false },
  };

  let requisitions = [];

  if (auth.role === ROLES.PROCUREMENT && stage === "processing") {
    const supervisory = [
      PROCUREMENT_POSITIONS.DIRECTOR,
      PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR,
    ].includes(auth.procurementPosition);

    requisitions = await Requisition.find({
      ...base,
      status: REQUISITION_STATUS.APPROVED,
      procurementStatus: "processing",
      ...(supervisory ? {} : { procurementOfficer: auth.sub }),
    })
      .populate("requester", "fullName email department")
      .sort({ updatedAt: -1 })
      .lean();
  } else if (auth.role === ROLES.PROCUREMENT && stage === "awaiting-vc") {
    const supervisory = [
      PROCUREMENT_POSITIONS.DIRECTOR,
      PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR,
    ].includes(auth.procurementPosition);

    requisitions = await Requisition.find({
      ...base,
      status: REQUISITION_STATUS.PENDING,
      procurementStatus: "submitted_to_vc",
      ...(supervisory ? {} : { procurementOfficer: auth.sub }),
    })
      .populate("requester", "fullName email department")
      .sort({ submittedToVcAt: -1, updatedAt: -1 })
      .lean();
  } else if (auth.role === ROLES.PROCUREMENT && stage === "director-review") {
    if (auth.procurementPosition !== PROCUREMENT_POSITIONS.DIRECTOR) {
      requisitions = [];
    } else {
      requisitions = await Requisition.find({
        ...base,
        status: REQUISITION_STATUS.PENDING,
        procurementStatus: "director_review",
        "approvalChain.approver": auth.sub,
      })
        .populate("requester", "fullName email department")
        .sort({ updatedAt: -1 })
        .lean();
    }
  } else if (auth.role === ROLES.PROCUREMENT && stage === "market-survey") {
    const operational = [
      PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR,
      PROCUREMENT_POSITIONS.PROCUREMENT_OFFICER_I,
      PROCUREMENT_POSITIONS.PROCUREMENT_OFFICER_II,
    ];
    const supervisory = [
      PROCUREMENT_POSITIONS.DIRECTOR,
      PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR,
    ].includes(auth.procurementPosition);

    // Administrative/clerical Procurement staff have no market-survey queue.
    if (!operational.includes(auth.procurementPosition) && !supervisory) {
      requisitions = [];
    } else {
      requisitions = await Requisition.find({
        ...base,
        status: REQUISITION_STATUS.PENDING,
        $or: [
          { procurementStatus: "review" },
          {
            procurementStatus: { $exists: false },
            approvalChain: {
              $elemMatch: {
                approver: auth.sub,
                type: "procurement_review",
              },
            },
          },
        ],
        ...(supervisory ? {} : { procurementOfficer: auth.sub }),
      })
        .populate("requester", "fullName email department")
        .sort({ submittedAt: -1, updatedAt: -1 })
        .lean();
    }
  } else {
    requisitions = await Requisition.find({
      ...base,
      status: { $in: [REQUISITION_STATUS.PENDING, REQUISITION_STATUS.RETURNED] },
      "approvalChain.approver": auth.sub,
    })
      .populate("requester", "fullName email department")
      .sort({ submittedAt: -1 })
      .lean();
  }

  const myTurn = requisitions.filter((r) => {
    const step = r.approvalChain?.[r.currentStepIndex];
    if (auth.role === ROLES.PROCUREMENT) {
      const supervisory = [
        PROCUREMENT_POSITIONS.DIRECTOR,
        PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR,
      ].includes(auth.procurementPosition);

      if (stage === "processing") {
        return step?.role === ROLES.PROCUREMENT && step?.type === "processing" &&
          (supervisory || String(step?.approver) === String(auth.sub));
      }
      if (stage === "awaiting-vc") return true;
      if (stage === "director-review") {
        return auth.procurementPosition === PROCUREMENT_POSITIONS.DIRECTOR &&
          step?.role === ROLES.PROCUREMENT &&
          step?.type === "procurement_review" &&
          requisition?.procurementStatus === "director_review" &&
          String(step?.approver) === String(auth.sub);
      }
      return step?.role === ROLES.PROCUREMENT && step?.type === "procurement_review" &&
        (supervisory || String(step?.approver) === String(auth.sub));
    }
    return step?.type === "approval" && String(step?.approver) === String(auth.sub);
  });

  return NextResponse.json({ requisitions: stage === "awaiting-vc" && auth.role === ROLES.PROCUREMENT ? requisitions : myTurn, stage });
}
