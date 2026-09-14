import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { verifyToken } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import Requisition from "@/models/Requisition";
import { draftRequisitionSchema } from "@/lib/validators/requisition";
import { saveDraft } from "@/services/requisitionService";
import { ROLES } from "@/constants/roles";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";
import { buildRequisitionVisibilityQuery, canViewRequisition } from "@/lib/requisitionVisibility";

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
  if (!auth) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  await connectDB();
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const query = { ...buildRequisitionVisibilityQuery(auth) };
  if (status) {
    if (query.$or) query.$or = query.$or.map((condition) => ({ ...condition, status }));
    else query.status = status;
  }
  const possibleRequisitions = await Requisition.find(query).sort({ createdAt: -1 }).populate("requester", "fullName email role").lean();
  const requisitions = possibleRequisitions.filter((r) => canViewRequisition(r, auth));
  return NextResponse.json({ requisitions });
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
