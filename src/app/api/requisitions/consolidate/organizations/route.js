import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";

import Requisition from "@/models/Requisition";

import { ROLES } from "@/constants/roles";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";
import { COLLEGES } from "@/constants/colleges";

function getAuth() {
  const token = cookies().get("token")?.value;
  return token ? verifyToken(token) : null;
}

/*
 * --------------------------------------------------
 * GET /api/requisitions/consolidate/organizations
 * --------------------------------------------------
 *
 * Returns requisitions that the logged-in user is
 * authorized to consolidate.
 *
 * Authority:
 *
 * DEAN
 *   -> faculties under their college
 *
 * PROVOST
 *   -> all faculties/departments under their college
 *
 * VC
 *   -> university-wide
 *
 * PROCUREMENT
 *   -> university-wide
 *
 * ADMIN
 *   -> university-wide
 */
export async function GET() {
  const auth = getAuth();

  if (!auth) {
    return NextResponse.json(
      { message: "Unauthorized" },
      { status: 401 }
    );
  }

  const allowedRoles = [
    ROLES.DEAN,
    ROLES.PROVOST,
    ROLES.VC,
    ROLES.PROCUREMENT,
    ROLES.ADMIN,
  ];

  if (!allowedRoles.includes(auth.role)) {
    return NextResponse.json(
      {
        message:
          "Your role is not allowed to create consolidated requisitions.",
      },
      { status: 403 }
    );
  }

  await connectDB();

  /*
   * --------------------------------------------------
   * ELIGIBLE SOURCE REQUISITIONS
   * --------------------------------------------------
   *
   * Drafts and rejected requisitions are always excluded.
   * Beyond that, eligibility depends on WHEN each role is
   * meant to consolidate:
   *
   *  - Dean/Provost/VC: consolidating IS their approval
   *    action, so they may only pick requisitions that are
   *    actually sitting at their own step right now. For
   *    VC this also means the consolidated result is
   *    immediately finalized — VC is the last approval
   *    step, so there's nothing left to route it to.
   *  - Procurement/Admin: consolidation happens AFTER full
   *    approval, as a post-approval grouping step, so only
   *    already-VC-approved requisitions are eligible.
   */
  const isPreApprovalConsolidator =
    auth.role === ROLES.DEAN ||
    auth.role === ROLES.PROVOST ||
    auth.role === ROLES.VC;

  const isPostApprovalConsolidator =
    auth.role === ROLES.PROCUREMENT ||
    auth.role === ROLES.ADMIN;

  const statusFilter = isPreApprovalConsolidator
    ? [
        REQUISITION_STATUS.PENDING,
        REQUISITION_STATUS.RETURNED,
      ]
    : isPostApprovalConsolidator
    ? [
        REQUISITION_STATUS.PENDING,
        REQUISITION_STATUS.APPROVED,
      ]
    : [
        REQUISITION_STATUS.PENDING,
        REQUISITION_STATUS.RETURNED,
        REQUISITION_STATUS.APPROVED,
      ];

  const baseQuery = {
    status: {
      $in: statusFilter,
    },

    awaitingRequesterAction: {
      $ne: true,
    },

    isConsolidated: {
      $ne: true,
    },

    consolidatedInto: {
      $exists: false,
    },
  };

  /*
   * --------------------------------------------------
   * APPLY ORGANIZATIONAL SCOPE
   * --------------------------------------------------
   */

  let query = {
    ...baseQuery,
  };

  /*
   * DEAN
   *
   * A Dean only consolidates requisitions from
   * their own college and faculty.
   */
  if (auth.role === ROLES.DEAN) {
    query.collegeId = auth.collegeId;
    query.facultyId = auth.facultyId;
  }

  /*
   * PROVOST
   *
   * A Provost can consolidate requisitions from
   * all faculties/departments in their college.
   */
  else if (auth.role === ROLES.PROVOST) {
    query.collegeId = auth.collegeId;
  }

  /*
   * VC
   *
   * University-wide.
   *
   * No organizational restriction.
   */

  /*
   * PROCUREMENT
   *
   * University-wide.
   *
   * Procurement visits departments across the
   * university and can select requirements from
   * multiple colleges.
   */

  /*
   * ADMIN
   *
   * University-wide.
   */

  const requisitions =
    (
      await Requisition.find(query)
        .sort({
          collegeId: 1,
          facultyId: 1,
          department: 1,
          createdAt: 1,
        })
        .populate(
          "requester",
          "fullName email role"
        )
        .lean()
    ).filter((requisition) => {
      /*
       * Dean/Provost: being in their scope isn't enough —
       * it must actually be THEIR turn to act on it right
       * now (not still with HOD, not already past them).
       */
      if (isPostApprovalConsolidator) {
        if (requisition.status === REQUISITION_STATUS.APPROVED) return true;

        if (auth.role === ROLES.PROCUREMENT) {
          const step = requisition.approvalChain?.[requisition.currentStepIndex];
          const isProcurementIntake =
            requisition.status === REQUISITION_STATUS.PENDING &&
            step?.role === ROLES.PROCUREMENT &&
            step?.type === "procurement_review";

          if (!isProcurementIntake) return false;

          const supervisory =
            auth.procurementPosition === "director" ||
            auth.procurementPosition === "principal_senior";

          return supervisory || String(step.approver) === String(auth.sub);
        }

        return false;
      }

      const step =
        requisition.approvalChain?.[
          requisition.currentStepIndex
        ];

      return (
        step &&
        String(step.approver) ===
          String(auth.sub)
      );
    });

  /*
   * --------------------------------------------------
   * BUILD ORGANIZATIONAL TREE
   * --------------------------------------------------
   *
   * Result:
   *
   * College
   *   Faculty
   *     Department
   *       Requisitions
   */
  const organizationMap = new Map();

  for (const requisition of requisitions) {
    const collegeId =
      requisition.collegeId || "N/A";

    const facultyId =
      requisition.facultyId || "N/A";

    const department =
      requisition.department || "N/A";

    if (!organizationMap.has(collegeId)) {
      organizationMap.set(collegeId, {
        collegeId,
        faculties: new Map(),
      });
    }

    const college =
      organizationMap.get(collegeId);

    if (!college.faculties.has(facultyId)) {
      college.faculties.set(
        facultyId,
        {
          facultyId,
          departments: new Map(),
        }
      );
    }

    const faculty =
      college.faculties.get(facultyId);

    if (!faculty.departments.has(department)) {
      faculty.departments.set(
        department,
        {
          department,
          requisitions: [],
        }
      );
    }

    faculty.departments
      .get(department)
      .requisitions
      .push(requisition);
  }

  /*
   * --------------------------------------------------
   * CONVERT MAPS TO ARRAYS
   * --------------------------------------------------
   */
  const organizations =
    [...organizationMap.values()].map(
      (college) => ({
        collegeId: college.collegeId,

        faculties: [
          ...college.faculties.values(),
        ].map((faculty) => ({
          facultyId: faculty.facultyId,

          departments: [
            ...faculty.departments.values(),
          ],
        })),
      })
    );

  return NextResponse.json({
    organizations,
  });
}
