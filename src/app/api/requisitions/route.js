import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import Requisition from "@/models/Requisition";
import { draftRequisitionSchema } from "@/lib/validators/requisition";
import { saveDraft } from "@/services/requisitionService";
import { ROLES } from "@/constants/roles";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";

// --------------------------------------------
// Helper: get authenticated user from token
// --------------------------------------------
function getAuth() {
  const token = cookies().get("token")?.value;
  return token ? verifyToken(token) : null;
}

// --------------------------------------------
// Approval roles
// --------------------------------------------
const APPROVER_ROLES = [
  ROLES.HOD,
  ROLES.DEAN,
  ROLES.PROVOST,
  ROLES.VC,
];

// --------------------------------------------
// GET /api/requisitions
// --------------------------------------------
export async function GET(request) {
  const auth = getAuth();

  if (!auth) {
    return NextResponse.json(
      { message: "Unauthorized" },
      { status: 401 }
    );
  }

  await connectDB();

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  // --------------------------------------------
  // ADMIN
  // --------------------------------------------
  // Admin can see all requisitions.
  if (auth.role === ROLES.ADMIN) {
    const query = status ? { status } : {};

    const requisitions = await Requisition.find(query)
      .sort({ createdAt: -1 })
      .populate("requester", "fullName email role")
      .lean();

    return NextResponse.json({
      requisitions,
    });
  }

  // --------------------------------------------
  // REQUESTER
  // --------------------------------------------
  // A normal requester sees only requisitions
  // created by them.
  if (auth.role === ROLES.REQUESTER) {
    const query = {
      requester: auth.sub,
    };

    if (status) {
      query.status = status;
    }

    const requisitions = await Requisition.find(query)
      .sort({ createdAt: -1 })
      .populate("requester", "fullName email role")
      .lean();

    return NextResponse.json({
      requisitions,
    });
  }

  // --------------------------------------------
  // HOD / DEAN / PROVOST / VC
  // --------------------------------------------
  //
  // They can see:
  //
  // 1. Their own requisitions.
  //
  // 2. Requisitions currently waiting for THEIR
  //    approval.
  //
  // IMPORTANT:
  //
  // We do not simply use:
  //
  // approvalChain.approver === auth.sub
  //
  // because that would also return requisitions
  // that have already passed this approver.
  //
  // Instead, after loading possible requisitions,
  // we check approvalChain[currentStepIndex].
  //
  if (APPROVER_ROLES.includes(auth.role)) {
    const query = {
      $or: [
        // Their own requisitions
        {
          requester: auth.sub,
        },

        // Requisitions that could currently be
        // waiting for their approval
        {
          status: {
            $in: [
              REQUISITION_STATUS.PENDING,
              REQUISITION_STATUS.RETURNED,
            ],
          },

          awaitingRequesterAction: {
            $ne: true,
          },

          "approvalChain.approver": auth.sub,
        },
      ],
    };

    /*
     * Apply status filter to both branches.
     *
     * This means if the frontend requests:
     *
     * /api/requisitions?status=pending
     *
     * the user still only sees requisitions
     * belonging to their visibility scope.
     */
    if (status) {
      query.$or = query.$or.map((condition) => ({
        ...condition,
        status,
      }));
    }

    const possibleRequisitions = await Requisition.find(query)
      .sort({ createdAt: -1 })
      .populate("requester", "fullName email role")
      .lean();

    /*
     * Now perform the important current-step check.
     */
    const requisitions = possibleRequisitions.filter(
      (requisition) => {
        // --------------------------------------------
        // User's own requisition
        // --------------------------------------------
        if (
          String(
            requisition.requester?._id ||
              requisition.requester
          ) === String(auth.sub)
        ) {
          return true;
        }

        // --------------------------------------------
        // Current approval step
        // --------------------------------------------
        const currentStep =
          requisition.approvalChain?.[
            requisition.currentStepIndex
          ];

        /*
         * The requisition is visible to this approver
         * ONLY when:
         *
         * 1. The current step exists
         * 2. The current step is an approval step
         * 3. This user is the current approver
         */
        return (
          currentStep &&
          (currentStep.type === "approval" || currentStep.type === "procurement_review") &&
          String(currentStep.approver) === String(auth.sub)
        );
      }
    );

    return NextResponse.json({
      requisitions,
    });
  }

  // --------------------------------------------
  // PROCUREMENT
  // --------------------------------------------
  //
  // Procurement is NOT an approval authority.
  //
  // Procurement can see:
  //
  // 1. Requisitions they personally initiated.
  //
  // 2. Requisitions assigned to them.
  //
  // 3. Approved requisitions that are ready
  //    for procurement processing.
  //
  if (auth.role === ROLES.PROCUREMENT) {
    const query = {
      $or: [
        // Requisitions personally initiated
        {
          requester: auth.sub,
        },

        // Requisitions assigned to this
        // procurement officer
        {
          procurementOfficer: auth.sub,
        },

        // Requisitions currently waiting for Procurement market survey
        {
          status: REQUISITION_STATUS.PENDING,
          "approvalChain.approver": auth.sub,
        },

        // Approved requisitions ready for final procurement processing
        {
          status: REQUISITION_STATUS.APPROVED,
          procurementStatus: { $in: ["ready", "processing"] },
        },
      ],
    };

    if (status) {
      query.$or = query.$or.map((condition) => ({
        ...condition,
        status,
      }));
    }

    const possibleRequisitions = await Requisition.find(query)
      .sort({ createdAt: -1 })
      .populate("requester", "fullName email role")
      .lean();

    const requisitions = possibleRequisitions.filter((r) => {
      const currentStep = r.approvalChain?.[r.currentStepIndex];

      const isCurrentReview =
        currentStep?.type === "procurement_review" &&
        String(currentStep.approver) === String(auth.sub);

      const isFinalProcessing =
        r.status === REQUISITION_STATUS.APPROVED &&
        r.procurementOfficer &&
        String(r.procurementOfficer) === String(auth.sub) &&
        ["ready", "processing"].includes(r.procurementStatus);

      const isOwn = String(r.requester?._id || r.requester) === String(auth.sub);

      return isCurrentReview || isFinalProcessing || isOwn;
    });

    return NextResponse.json({
      requisitions,
    });
  }

  // --------------------------------------------
  // FALLBACK
  // --------------------------------------------
  //
  // Any unexpected role gets only its own
  // requisitions.
  //
  const query = {
    requester: auth.sub,
  };

  if (status) {
    query.status = status;
  }

  const requisitions = await Requisition.find(query)
    .sort({ createdAt: -1 })
    .populate("requester", "fullName email role")
    .lean();

  return NextResponse.json({
    requisitions,
  });
}

// --------------------------------------------
// POST /api/requisitions
// --------------------------------------------
export async function POST(request) {
  const auth = getAuth();

  if (!auth) {
    return NextResponse.json(
      { message: "Unauthorized" },
      { status: 401 }
    );
  }

  // --------------------------------------------
  // Roles allowed to create requisitions
  // --------------------------------------------
  const ALLOWED_TO_CREATE = [
    ROLES.REQUESTER,
    ROLES.HOD,
    ROLES.DEAN,
    ROLES.PROVOST,
    ROLES.PROCUREMENT,
  ];

  if (!ALLOWED_TO_CREATE.includes(auth.role)) {
    return NextResponse.json(
      {
        message:
          "Forbidden: Your role does not allow creating requisitions.",
      },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();

    const { error, value } =
      draftRequisitionSchema.validate(body);

    if (error) {
      return NextResponse.json(
        {
          message: error.details[0].message,
        },
        { status: 400 }
      );
    }

    await connectDB();

    const requisition = await saveDraft({
      requesterUser: {
        id: auth.sub,
        role: auth.role,
        collegeId: auth.collegeId,
        facultyId: auth.facultyId,
        department: auth.department,
      },
      payload: value,
    });

    return NextResponse.json(
      { requisition },
      { status: 201 }
    );
  } catch (err) {
    console.error(err);

    return NextResponse.json(
      {
        message:
          err.message ||
          "Failed to create requisition.",
      },
      { status: 500 }
    );
  }
}
