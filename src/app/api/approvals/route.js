import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import Requisition from "@/models/Requisition";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";
import { APPROVER_ROLES, ROLES } from "@/constants/roles";

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

  const base = {
    awaitingRequesterAction: { $ne: true },
    consolidatedInto: { $exists: false },
  };

  let requisitions = [];

  if (auth.role === ROLES.PROCUREMENT && stage === "processing") {
    requisitions = await Requisition.find({
      ...base,
      status: REQUISITION_STATUS.APPROVED,
      procurementOfficer: auth.sub,
      procurementStatus: { $in: ["ready", "processing", "completed"] },
    })
      .populate("requester", "fullName email department")
      .sort({ updatedAt: -1 })
      .lean();
  } else if (auth.role === ROLES.PROCUREMENT && stage === "awaiting-vc") {
    requisitions = await Requisition.find({
      ...base,
      status: REQUISITION_STATUS.PENDING,
      procurementOfficer: auth.sub,
      procurementStatus: "submitted_to_vc",
    })
      .populate("requester", "fullName email department")
      .sort({ submittedToVcAt: -1, updatedAt: -1 })
      .lean();
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
      if (stage === "processing") {
        return step?.role === ROLES.PROCUREMENT && step?.type === "processing" && String(step?.approver) === String(auth.sub);
      }
      if (stage === "awaiting-vc") return false;
      return step?.role === ROLES.PROCUREMENT && step?.type === "procurement_review" && String(step?.approver) === String(auth.sub);
    }
    return step?.type === "approval" && String(step?.approver) === String(auth.sub);
  });

  return NextResponse.json({ requisitions: stage === "awaiting-vc" && auth.role === ROLES.PROCUREMENT ? requisitions : myTurn, stage });
}
