import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";

import Requisition from "@/models/Requisition";
import AuditLog from "@/models/AuditLog";

import {
  draftRequisitionSchema,
} from "@/lib/validators/requisition";

import {
  saveDraft,
} from "@/services/requisitionService";

import { ROLES } from "@/constants/roles";

function getAuth() {
  const token = cookies().get("token")?.value;

  return token
    ? verifyToken(token)
    : null;
}

/*
 * --------------------------------------------------
 * ID COMPARISON HELPER
 * --------------------------------------------------
 *
 * Works with:
 * - MongoDB ObjectIds
 * - populated documents
 * - strings
 */
function sameId(a, b) {
  if (!a || !b) return false;

  const aId =
    typeof a === "object" && a._id
      ? a._id.toString()
      : a.toString();

  const bId =
    typeof b === "object" && b._id
      ? b._id.toString()
      : b.toString();

  return aId === bId;
}

/*
 * --------------------------------------------------
 * CAN VIEW REQUISITION
 * --------------------------------------------------
 *
 * Access rules:
 *
 * ADMIN
 *   Can view everything.
 *
 * AUDIT
 *   University-wide read access.
 *
 * STORE
 *   University-wide read access because Store may
 *   need to inspect approved/completed requisitions.
 *
 * VC
 *   University-wide access.
 *
 * PROCUREMENT
 *   University-wide access, plus specifically:
 *   - assigned procurement officer
 *   - assigned procurement review officer
 *   - assignment history
 *   - procurement approval-chain participation
 *
 * REQUESTER
 *   Can view requisitions they created.
 *
 * HOD
 *   Can view requisitions belonging to their
 *   college + faculty + department.
 *
 * DEAN
 *   Can view requisitions belonging to their
 *   college + faculty.
 *
 * PROVOST
 *   Can view requisitions belonging to their college.
 *
 * CONSOLIDATED REQUISITIONS
 *   Access is also determined from requestingUnits
 *   and item-level organizational snapshots.
 */
function canViewRequisition(requisition, auth) {
  if (!requisition || !auth) {
    return false;
  }

  const role = auth.role;

  /*
   * --------------------------------------------------
   * SYSTEM ADMIN
   * --------------------------------------------------
   */
  if (
    role === ROLES.ADMIN ||
    auth.isSystemAdmin === true
  ) {
    return true;
  }

  /*
   * --------------------------------------------------
   * UNIVERSITY-WIDE ROLES
   * --------------------------------------------------
   *
   * These roles need broad visibility of requisitions.
   */
  if (
    role === ROLES.VC ||
    role === ROLES.AUDIT ||
    role === ROLES.STORE
  ) {
    return true;
  }

  /*
   * --------------------------------------------------
   * PROCUREMENT
   * --------------------------------------------------
   *
   * Procurement operates university-wide.
   *
   * This also explicitly checks assignment fields so
   * a Procurement officer can access a requisition
   * assigned to them even if the requisition is not
   * currently in the normal approval chain.
   */
  if (role === ROLES.PROCUREMENT) {
    if (
      sameId(requisition.procurementOfficer, auth.sub)
    ) {
      return true;
    }

    if (
      sameId(requisition.procurementAssignedTo, auth.sub)
    ) {
      return true;
    }

    if (
      sameId(requisition.procurementAssignedBy, auth.sub)
    ) {
      return true;
    }

    if (
      Array.isArray(
        requisition.procurementAssignmentHistory
      )
    ) {
      const wasAssigned =
        requisition.procurementAssignmentHistory.some(
          (entry) =>
            sameId(entry.assignedTo, auth.sub) ||
            sameId(entry.assignedBy, auth.sub)
        );

      if (wasAssigned) {
        return true;
      }
    }

    /*
     * Procurement is university-wide, so it can also
     * view requisitions that have reached Procurement
     * workflow stages.
     */
    if (
      requisition.procurementStatus ||
      requisition.finalApprovalAt
    ) {
      return true;
    }

    /*
     * If Procurement is explicitly present in the
     * approval chain, allow access.
     */
    if (
      Array.isArray(requisition.approvalChain)
    ) {
      const isProcurementStep =
        requisition.approvalChain.some(
          (step) =>
            step.role === ROLES.PROCUREMENT ||
            sameId(step.approver, auth.sub)
        );

      if (isProcurementStep) {
        return true;
      }
    }

    return true;
  }

  /*
   * --------------------------------------------------
   * REQUESTER
   * --------------------------------------------------
   */
  if (role === ROLES.REQUESTER) {
    return sameId(
      requisition.requester,
      auth.sub
    );
  }

  /*
   * --------------------------------------------------
   * APPROVAL CHAIN PARTICIPATION
   * --------------------------------------------------
   *
   * If the authenticated user is the actual approver
   * assigned to this requisition, they must be able
   * to open it regardless of organizational fields.
   *
   * This is especially useful if a user has been
   * explicitly assigned as an approver.
   */
  if (
    Array.isArray(requisition.approvalChain)
  ) {
    const isAssignedApprover =
      requisition.approvalChain.some(
        (step) =>
          sameId(step.approver, auth.sub)
      );

    if (isAssignedApprover) {
      return true;
    }
  }

  /*
   * --------------------------------------------------
   * ORGANIZATIONAL ACCESS
   * --------------------------------------------------
   *
   * First handle NORMAL requisitions.
   */
  if (!requisition.isConsolidated) {
    const sameCollege =
      requisition.collegeId &&
      auth.collegeId &&
      requisition.collegeId.toString() ===
        auth.collegeId.toString();

    const sameFaculty =
      requisition.facultyId &&
      auth.facultyId &&
      requisition.facultyId.toString() ===
        auth.facultyId.toString();

    const sameDepartment =
      requisition.department &&
      auth.department &&
      requisition.department.toString() ===
        auth.department.toString();

    /*
     * HOD:
     * College + Faculty + Department
     */
    if (role === ROLES.HOD) {
      return (
        sameCollege &&
        sameFaculty &&
        sameDepartment
      );
    }

    /*
     * DEAN:
     * College + Faculty
     *
     * Dean does NOT require a department because
     * the Dean supervises multiple departments.
     */
    if (role === ROLES.DEAN) {
      return (
        sameCollege &&
        sameFaculty
      );
    }

    /*
     * PROVOST:
     * College only.
     *
     * Provost does NOT require a department or
     * faculty because the Provost supervises the
     * entire college.
     */
    if (role === ROLES.PROVOST) {
      return sameCollege;
    }

    return false;
  }

  /*
   * --------------------------------------------------
   * CONSOLIDATED REQUISITION
   * --------------------------------------------------
   *
   * Consolidated requisitions may contain several
   * departments/faculties within the same college.
   *
   * Therefore we inspect:
   *
   * 1. requestingUnits
   * 2. item.requestingCollegeId
   * 3. item.requestingFacultyId
   * 4. item.requestingDepartment
   */
  const units = Array.isArray(
    requisition.requestingUnits
  )
    ? requisition.requestingUnits
    : [];

  const items = Array.isArray(
    requisition.items
  )
    ? requisition.items
    : [];

  /*
   * --------------------------------------------------
   * HOD
   * --------------------------------------------------
   *
   * HOD may access the consolidated requisition if
   * at least one unit/item belongs to the HOD's
   * exact department.
   */
  if (role === ROLES.HOD) {
    const matchingUnit =
      units.some(
        (unit) =>
          unit.collegeId?.toString() ===
            auth.collegeId?.toString() &&
          unit.facultyId?.toString() ===
            auth.facultyId?.toString() &&
          unit.department?.toString() ===
            auth.department?.toString()
      );

    const matchingItem =
      items.some(
        (item) =>
          item.requestingCollegeId?.toString() ===
            auth.collegeId?.toString() &&
          item.requestingFacultyId?.toString() ===
            auth.facultyId?.toString() &&
          item.requestingDepartment?.toString() ===
            auth.department?.toString()
      );

    return matchingUnit || matchingItem;
  }

  /*
   * --------------------------------------------------
   * DEAN
   * --------------------------------------------------
   *
   * Dean can access if any consolidated unit/item
   * belongs to the Dean's faculty.
   */
  if (role === ROLES.DEAN) {
    const matchingUnit =
      units.some(
        (unit) =>
          unit.collegeId?.toString() ===
            auth.collegeId?.toString() &&
          unit.facultyId?.toString() ===
            auth.facultyId?.toString()
      );

    const matchingItem =
      items.some(
        (item) =>
          item.requestingCollegeId?.toString() ===
            auth.collegeId?.toString() &&
          item.requestingFacultyId?.toString() ===
            auth.facultyId?.toString()
      );

    return matchingUnit || matchingItem;
  }

  /*
   * --------------------------------------------------
   * PROVOST
   * --------------------------------------------------
   *
   * IMPORTANT:
   *
   * A Provost supervises the entire college.
   *
   * Therefore we intentionally DO NOT require:
   *
   *   department
   *   faculty
   *
   * This is also why the consolidation review should
   * not require the Provost to select a department.
   */
  if (role === ROLES.PROVOST) {
    const matchingUnit =
      units.some(
        (unit) =>
          unit.collegeId?.toString() ===
          auth.collegeId?.toString()
      );

    const matchingItem =
      items.some(
        (item) =>
          item.requestingCollegeId?.toString() ===
          auth.collegeId?.toString()
      );

    return matchingUnit || matchingItem;
  }

  return false;
}

/*
 * --------------------------------------------------
 * GET SINGLE REQUISITION
 * --------------------------------------------------
 */
export async function GET(
  request,
  { params }
) {
  const auth = getAuth();

  if (!auth) {
    return NextResponse.json(
      {
        message: "Unauthorized",
      },
      {
        status: 401,
      }
    );
  }

  await connectDB();

  const requisition =
    await Requisition.findById(
      params.id
    )
      .populate(
        "requester",
        "fullName email role department"
      )
      .populate(
        "comments.author",
        "fullName role"
      )
      .populate(
        "approvalChain.approver",
        "fullName role"
      )
      .populate(
        "procurementOfficer",
        "fullName email role procurementPosition"
      )
      .populate(
        "procurementAssignedTo",
        "fullName email role procurementPosition"
      )
      .populate(
        "procurementAssignedBy",
        "fullName email role procurementPosition"
      )
      .populate(
        "consolidatedInto",
        "requisitionNumber status currentStepIndex approvalChain procurementStatus"
      )
      .populate(
        "sourceRequisitions",
        "requisitionNumber category status collegeId facultyId department estimatedCost requester",
        null,
        {
          populate: {
            path: "requester",
            select: "fullName role",
          },
        }
      )
      .lean();

  if (!requisition) {
    return NextResponse.json(
      {
        message: "Requisition not found.",
      },
      {
        status: 404,
      }
    );
  }

  if (
    !canViewRequisition(
      requisition,
      auth
    )
  ) {
    return NextResponse.json(
      {
        message:
          "Forbidden: You do not have access to this requisition.",
      },
      {
        status: 403,
      }
    );
  }

  return NextResponse.json({
    requisition,
  });
}

/*
 * --------------------------------------------------
 * PATCH
 * --------------------------------------------------
 *
 * Used for:
 *
 * 1. Editing a draft
 * 2. Editing a returned requisition
 * 3. Adding clarification comments
 */
export async function PATCH(
  request,
  { params }
) {
  const auth = getAuth();

  if (!auth) {
    return NextResponse.json(
      {
        message: "Unauthorized",
      },
      {
        status: 401,
      }
    );
  }

  try {
    const body =
      await request.json();

    await connectDB();

    /*
     * --------------------------------------------------
     * COMMENT
     * --------------------------------------------------
     */
    if (
      body.type === "comment"
    ) {
      if (
        !body.message ||
        !body.message.trim()
      ) {
        return NextResponse.json(
          {
            message:
              "Comment message is required.",
          },
          {
            status: 400,
          }
        );
      }

      const requisition =
        await Requisition.findByIdAndUpdate(
          params.id,
          {
            $push: {
              comments: {
                author: auth.sub,
                message:
                  body.message.trim(),
              },
            },
          },
          {
            new: true,
          }
        );

      if (!requisition) {
        return NextResponse.json(
          {
            message:
              "Requisition not found.",
          },
          {
            status: 404,
          }
        );
      }

      await AuditLog.create({
        actor: auth.sub,
        action:
          "requisition.comment",
        entityType:
          "Requisition",
        entityId:
          params.id,
      });

      return NextResponse.json({
        requisition,
      });
    }

    /*
     * --------------------------------------------------
     * EDIT DRAFT / RETURNED REQUISITION
     * --------------------------------------------------
     */
    const {
      error,
      value,
    } =
      draftRequisitionSchema.validate(
        body
      );

    if (error) {
      return NextResponse.json(
        {
          message:
            error.details[0]
              .message,
        },
        {
          status: 400,
        }
      );
    }

    const requisition =
      await saveDraft({
        requisitionId:
          params.id,

        requesterUser: {
          id: auth.sub,

          role:
            auth.role,

          collegeId:
            auth.collegeId,

          facultyId:
            auth.facultyId,

          department:
            auth.department,
        },

        payload: value,
      });

    return NextResponse.json({
      requisition,
    });
  } catch (err) {
    console.error(err);

    return NextResponse.json(
      {
        message:
          err.message ||
          "Update failed.",
      },
      {
        status: 500,
      }
    );
  }
  }
