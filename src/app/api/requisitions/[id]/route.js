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

function getAuth() {
  const token =
    cookies().get("token")?.value;

  return token
    ? verifyToken(token)
    : null;
}

/*
 * GET single requisition.
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
      ).populate(
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
        message:
          "Requisition not found.",
      },
      {
        status: 404,
      }
    );
  }

  return NextResponse.json({
    requisition,
  });
}

/*
 * PATCH
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
     * COMMENT
     */
    if (
      body.type ===
      "comment"
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
                author:
                  auth.sub,

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
        actor:
          auth.sub,

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
     * EDIT DRAFT / RETURNED REQUISITION
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
