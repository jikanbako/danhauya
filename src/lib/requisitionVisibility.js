import { ROLES } from "@/constants/roles";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";

function same(a, b) { return a != null && b != null && String(a) === String(b); }
function isOwn(requisition, auth) { return same(requisition?.requester?._id || requisition?.requester, auth?.sub); }
function currentStep(requisition) { return requisition?.approvalChain?.[requisition?.currentStepIndex]; }

export function canViewRequisition(requisition, auth) {
  if (!auth || !requisition) return false;
  if (auth.role === ROLES.ADMIN || auth.role === ROLES.VC) return true;
  if (auth.role === ROLES.REQUESTER) return isOwn(requisition, auth);
  if (auth.role === ROLES.HOD) {
    if (isOwn(requisition, auth)) return true;
    return same(requisition.collegeId, auth.collegeId) && same(requisition.facultyId, auth.facultyId) && String(requisition.department || "") === String(auth.department || "");
  }
  if (auth.role === ROLES.DEAN) {
    if (isOwn(requisition, auth)) return true;
    return same(requisition.collegeId, auth.collegeId) && same(requisition.facultyId, auth.facultyId);
  }
  if (auth.role === ROLES.PROVOST) {
    if (isOwn(requisition, auth)) return true;
    return same(requisition.collegeId, auth.collegeId);
  }
  if (auth.role === ROLES.PROCUREMENT) {
    if (isOwn(requisition, auth)) return true;
    if (same(requisition.procurementOfficer, auth.sub) || same(requisition.procurementAssignedTo, auth.sub) || same(requisition.procurementAssignedBy, auth.sub)) return true;
    const step = currentStep(requisition);
    if (step?.role === ROLES.PROCUREMENT && same(step.approver, auth.sub)) return true;
    return requisition.status === REQUISITION_STATUS.APPROVED && ["ready", "processing", "completed", "rejected"].includes(requisition.procurementStatus);
  }
  return false;
}

export function buildRequisitionVisibilityQuery(auth) {
  if (auth.role === ROLES.ADMIN || auth.role === ROLES.VC) return {};
  if (auth.role === ROLES.REQUESTER) return { requester: auth.sub };
  if (auth.role === ROLES.HOD) return { $or: [{ requester: auth.sub }, { collegeId: auth.collegeId, facultyId: auth.facultyId, department: auth.department }] };
  if (auth.role === ROLES.DEAN) return { $or: [{ requester: auth.sub }, { collegeId: auth.collegeId, facultyId: auth.facultyId }] };
  if (auth.role === ROLES.PROVOST) return { $or: [{ requester: auth.sub }, { collegeId: auth.collegeId }] };
  if (auth.role === ROLES.PROCUREMENT) return { $or: [
    { requester: auth.sub }, { procurementOfficer: auth.sub }, { procurementAssignedTo: auth.sub }, { procurementAssignedBy: auth.sub }, { "approvalChain.approver": auth.sub },
    { status: REQUISITION_STATUS.APPROVED, procurementStatus: { $in: ["ready", "processing", "completed", "rejected"] } },
  ] };
  return { requester: auth.sub };
}
