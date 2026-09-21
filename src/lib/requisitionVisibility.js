import { ROLES } from "@/constants/roles";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";
import { PROCUREMENT_POSITIONS } from "@/constants/procurement";

const PROCUREMENT_HISTORY_STATUSES = [
  "review",
  "submitted_to_vc",
  "ready",
  "processing",
  "completed",
  "rejected",
];

function same(value, expected) {
  const left = value?._id ?? value;
  const right = expected?._id ?? expected;
  return String(left ?? "") === String(right ?? "");
}

/**
 * Returns the database visibility scope for the authenticated user.
 * This is intentionally separate from approval routing: visibility is
 * broader than "whose turn is it?".
 */
export function getRequisitionVisibilityQuery(auth) {
  if (!auth) return null;

  switch (auth.role) {
    case ROLES.ADMIN:
    case ROLES.VC:
      return {};

    case ROLES.REQUESTER:
      return { requester: auth.sub };

    case ROLES.HOD:
      return {
        $or: [
          { requester: auth.sub },
          {
            collegeId: auth.collegeId,
            facultyId: auth.facultyId,
            department: auth.department,
          },
        ],
      };

    case ROLES.DEAN:
      return {
        $or: [
          { requester: auth.sub },
          {
            collegeId: auth.collegeId,
            facultyId: auth.facultyId,
          },
        ],
      };

    case ROLES.PROVOST:
      return {
        $or: [
          { requester: auth.sub },
          { collegeId: auth.collegeId },
        ],
      };

    case ROLES.PROCUREMENT: {
      const position = auth.procurementPosition;
      const isDirector =
        position === PROCUREMENT_POSITIONS.DIRECTOR;
      const isSenior = [
        PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR,
      ].includes(position);

      // Procurement visibility is workflow-based, not a blanket view of
      // every requisition in the university.
      const workflow = {
        procurementStatus: {
          $in: PROCUREMENT_HISTORY_STATUSES,
        },
      };

      if (isDirector || isSenior) {
        return {
          $or: [
            { requester: auth.sub },
            workflow,
            { procurementOfficer: auth.sub },
            { procurementAssignedTo: auth.sub },
            { procurementAssignedBy: auth.sub },
          ],
        };
      }

      return {
        $or: [
          { requester: auth.sub },
          { procurementOfficer: auth.sub },
          { procurementAssignedTo: auth.sub },
          { procurementAssignedBy: auth.sub },
        ],
      };
    }

    default:
      return { requester: auth.sub };
  }
}

/**
 * Applies a requested status without weakening the user's visibility scope.
 */
export function withStatusFilter(query, status) {
  if (!status) return query;
  return { $and: [query, { status }] };
}

/**
 * Final defensive check used after a broader Mongo query when populated
 * documents or legacy records make an exact scope check useful.
 */
export function canViewRequisition(auth, requisition) {
  if (!auth || !requisition) return false;

  if ([ROLES.ADMIN, ROLES.VC].includes(auth.role)) return true;
  if (same(requisition.requester?._id || requisition.requester, auth.sub)) return true;

  if (auth.role === ROLES.REQUESTER) return false;

  if (auth.role === ROLES.HOD) {
    return (
      same(requisition.collegeId, auth.collegeId) &&
      same(requisition.facultyId, auth.facultyId) &&
      same(requisition.department, auth.department)
    );
  }

  if (auth.role === ROLES.DEAN) {
    return (
      same(requisition.collegeId, auth.collegeId) &&
      same(requisition.facultyId, auth.facultyId)
    );
  }

  if (auth.role === ROLES.PROVOST) {
    return same(requisition.collegeId, auth.collegeId);
  }

  if (auth.role === ROLES.PROCUREMENT) {
    const position = auth.procurementPosition;
    const isDirector = position === PROCUREMENT_POSITIONS.DIRECTOR;
    const isSenior = position === PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR;

    if (
      same(requisition.procurementOfficer, auth.sub) ||
      same(requisition.procurementAssignedTo, auth.sub) ||
      same(requisition.procurementAssignedBy, auth.sub)
    ) return true;

    const currentStep = requisition.approvalChain?.[requisition.currentStepIndex];
    if (
      currentStep?.role === ROLES.PROCUREMENT &&
      currentStep?.type === "procurement_review" &&
      (isDirector || isSenior || same(currentStep.approver, auth.sub))
    ) return true;

    return Boolean(
      (isDirector || isSenior) &&
      PROCUREMENT_HISTORY_STATUSES.includes(requisition.procurementStatus)
    );
  }

  return false;
}

export { PROCUREMENT_HISTORY_STATUSES };
