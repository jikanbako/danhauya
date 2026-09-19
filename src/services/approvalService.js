import Requisition from "@/models/Requisition";
import Approval from "@/models/Approval";
import AuditLog from "@/models/AuditLog";
import User from "@/models/User";

import {
  REQUISITION_STATUS,
  APPROVAL_ACTIONS,
} from "@/constants/requisitionOptions";

import {
  sendApprovalStepEmail,
  sendRequisitionApprovedEmail,
  sendRequisitionRejectedEmail,
  sendRequisitionReturnedEmail,
} from "@/lib/mailer";

import { ROLES } from "@/constants/roles";
import {
  PROCUREMENT_ASSIGNMENT_POSITIONS,
  PROCUREMENT_MARKET_SURVEY_POSITIONS,
} from "@/constants/procurement";

import {
  generateRequisitionNumber,
} from "@/services/requisitionService";

/*
 * --------------------------------------------------
 * LOAD AND VERIFY CURRENT APPROVAL STEP
 * --------------------------------------------------
 */
export async function loadAndVerifyStep(
  requisitionId,
  approverId
) {
  const requisition =
    await Requisition.findById(
      requisitionId
    ).populate("requester");

  if (!requisition) {
    throw new Error(
      "Requisition not found."
    );
  }

  /*
   * Only pending requisitions can normally
   * receive an approval action.
   */
  if (
    requisition.status !==
    REQUISITION_STATUS.PENDING
  ) {
    const atApproverStep =
      requisition.status ===
        REQUISITION_STATUS.RETURNED &&
      !requisition.awaitingRequesterAction;

    if (!atApproverStep) {
      throw new Error(
        "This requisition is not currently awaiting your action."
      );
    }
  }

  const step =
    requisition.approvalChain[
      requisition.currentStepIndex
    ];

  if (!step) {
    throw new Error(
      "Invalid approval step."
    );
  }

  /*
   * Make sure this user is the assigned
   * person for the current step.
   */
  if (
    String(step.approver) !==
    String(approverId)
  ) {
    throw new Error(
      "You are not the assigned approver for this requisition's current step."
    );
  }

  /*
   * Procurement has its own market-survey stage.
   * It must use the dedicated procurement review action,
   * not the normal approval endpoint.
   */
  if (step.type === "procurement_review") {
    throw new Error(
      "Procurement must complete the market survey and submit the requisition to the VC from the Procurement Review stage."
    );
  }

  /*
   * Procurement is a post-VC processing stage, not an approval.
   */
  if (step.type === "processing") {
    throw new Error(
      "This requisition has already received final approval and is now with Procurement for processing."
    );
  }

  return requisition;
}

/*
 * --------------------------------------------------
 * APPROVE CURRENT STEP
 * --------------------------------------------------
 */
export async function approveStep({
  requisitionId,
  approverUser,
  comment,
}) {
  const requisition =
    await loadAndVerifyStep(
      requisitionId,
      approverUser.id
    );

  const step =
    requisition.approvalChain[
      requisition.currentStepIndex
    ];

  /*
   * Record the approval decision.
   */
  await Approval.create({
    requisition:
      requisition._id,

    stepIndex:
      requisition.currentStepIndex,

    role:
      step.role,

    approver:
      approverUser.id,

    action:
      APPROVAL_ACTIONS.APPROVE,

    comment,
  });

  /*
   * VC is the final approval authority.
   */
  const isFinalApproval =
    step.role === ROLES.VC;

  const nextIndex =
    requisition.currentStepIndex + 1;

  const nextStep =
    requisition.approvalChain[
      nextIndex
    ];

  /*
   * --------------------------------------------------
   * FINAL APPROVAL BY VC
   * --------------------------------------------------
   */
  if (isFinalApproval) {
    requisition.status =
      REQUISITION_STATUS.APPROVED;

    requisition.finalApprovalAt =
      new Date();

    requisition.decidedAt =
      new Date();

    requisition.awaitingRequesterAction =
      false;

    /*
     * Find Procurement stage.
     */
    const procurementStep =
      requisition.approvalChain.find(
        (approvalStep) =>
          approvalStep.role ===
            ROLES.PROCUREMENT &&
          approvalStep.type ===
            "processing"
      );

    /*
     * Assign Procurement Officer.
     */
    let procurementOfficer = null;

    if (
      procurementStep?.approver
    ) {
      procurementOfficer =
        await User.findById(
          procurementStep.approver
        );
    }

    /*
     * If the chain does not contain a
     * Procurement Officer, find an active one.
     */
    if (!procurementOfficer) {
      procurementOfficer =
        await User.findOne({
          role: ROLES.PROCUREMENT,
          accountStatus: "active",
        });
    }

    if (!procurementOfficer) {
      throw new Error(
        "No active Procurement Officer is configured."
      );
    }

    /*
     * Move current stage to Procurement.
     */
    if (procurementStep) {
      const procurementIndex =
        requisition.approvalChain.findIndex(
          (approvalStep) =>
            approvalStep.role ===
              ROLES.PROCUREMENT &&
            approvalStep.type ===
              "processing"
        );

      if (
        procurementIndex >= 0
      ) {
        requisition.currentStepIndex =
          procurementIndex;
      }
    }

    /*
     * --------------------------------------------------
     * PROCUREMENT STATUS
     * --------------------------------------------------
     *
     * VC has approved.
     *
     * Therefore Procurement can now begin.
     */
    requisition.procurementStatus =
      "ready";

    requisition.procurementOfficer =
      procurementOfficer._id;

    requisition.procurementReceivedAt =
      new Date();

    await requisition.save();

    await syncConsolidatedSourcesAfterApproval({
      representative: requisition,
      approvedStep: step,
      approverId: approverUser.id,
      comment,
    });

    /*
     * Audit final approval.
     */
    await AuditLog.create({
      actor:
        approverUser.id,

      action:
        "requisition.final_approval",

      entityType:
        "Requisition",

      entityId:
        requisition._id,

      details: {
        finalApproverRole:
          step.role,

        nextStage:
          ROLES.PROCUREMENT,

        procurementOfficer:
          procurementOfficer._id,
      },
    });

    /*
     * Notify requester.
     */
    await sendRequisitionApprovedEmail(
      requisition.requester,
      requisition
    );

    /*
     * Notify Procurement Officer.
     */
    await sendApprovalStepEmail(
      procurementOfficer,
      requisition
    );

    return requisition;
  }

  /*
   * --------------------------------------------------
   * NORMAL APPROVAL
   * --------------------------------------------------
   *
   * HOD -> Dean
   * Dean -> Provost
   * Provost -> VC
   */
  requisition.currentStepIndex =
    nextIndex;

  requisition.status =
    REQUISITION_STATUS.PENDING;

  requisition.awaitingRequesterAction =
    false;

  await requisition.save();

  await syncConsolidatedSourcesAfterApproval({
    representative: requisition,
    approvedStep: step,
    approverId: approverUser.id,
    comment,
  });

  await AuditLog.create({
    actor:
      approverUser.id,

    action:
      "requisition.approve",

    entityType:
      "Requisition",

    entityId:
      requisition._id,

    details: {
      stepIndex:
        nextIndex,

      role:
        step.role,
    },
  });

  /*
   * Notify next approver.
   */
  if (
    nextStep?.approver
  ) {
    const nextApprover =
      await User.findById(
        nextStep.approver
      );

    if (nextApprover) {
      await sendApprovalStepEmail(
        nextApprover,
        requisition
      );
    }
  }

  return requisition;
}

/*
 * --------------------------------------------------
 * CONSOLIDATED SOURCE WORKFLOW SYNCHRONIZATION
 * --------------------------------------------------
 *
 * A consolidated requisition is the representative workflow record,
 * but every source requisition remains visible to its requester. This
 * helper mirrors the representative's completed approval into each
 * source requisition so source tracking never remains stuck at the
 * old approver.
 */
async function syncConsolidatedSourcesAfterApproval({
  representative,
  approvedStep,
  approverId,
  comment,
  recordApproval = true,
}) {
  if (
    !representative?.isConsolidated ||
    !Array.isArray(representative.sourceRequisitions) ||
    representative.sourceRequisitions.length === 0
  ) {
    return;
  }

  const sources = await Requisition.find({
    _id: { $in: representative.sourceRequisitions },
  });

  for (const source of sources) {
    const sourceStep = source.approvalChain?.[source.currentStepIndex];

    // Only mirror the decision when this source is still at the same
    // authority. This protects against stale/duplicate approval calls.
    if (
      !sourceStep ||
      sourceStep.role !== approvedStep?.role ||
      sourceStep.type !== approvedStep?.type ||
      String(sourceStep.approver) !== String(approverId)
    ) {
      continue;
    }

    if (recordApproval) {
      await Approval.create({
        requisition: source._id,
        stepIndex: source.currentStepIndex,
        role: sourceStep.role,
        approver: approverId,
        action: APPROVAL_ACTIONS.APPROVE,
        comment: comment || `Approved through consolidation ${representative.requisitionNumber || representative._id}.`,
      });
    }

    const nextIndex = source.currentStepIndex + 1;
    const nextStep = source.approvalChain?.[nextIndex];

    if (sourceStep.role === ROLES.VC) {
      const processingIndex = source.approvalChain?.findIndex(
        (step) => step.role === ROLES.PROCUREMENT && step.type === "processing"
      );
      const processingStep =
        processingIndex >= 0 ? source.approvalChain[processingIndex] : null;

      source.status = REQUISITION_STATUS.APPROVED;
      source.finalApprovalAt = new Date();
      source.decidedAt = new Date();
      source.awaitingRequesterAction = false;
      source.currentStepIndex =
        processingIndex >= 0 ? processingIndex : source.currentStepIndex;
      source.procurementStatus = "ready";

      if (processingStep?.approver) {
        source.procurementOfficer = processingStep.approver;
        source.procurementReceivedAt = new Date();
      }
    } else if (nextStep) {
      source.currentStepIndex = nextIndex;
      source.status = REQUISITION_STATUS.PENDING;
      source.awaitingRequesterAction = false;
    }

    await source.save();

    await AuditLog.create({
      actor: approverId,
      action: "requisition.consolidated_source_advanced",
      entityType: "Requisition",
      entityId: source._id,
      details: {
        representativeRequisition: representative._id,
        approvedRole: approvedStep?.role,
        nextStepIndex: source.currentStepIndex,
        nextStepRole: source.approvalChain?.[source.currentStepIndex]?.role,
      },
    });
  }
}

/*
 * --------------------------------------------------
 * PROCUREMENT INTERNAL ASSIGNMENT
 * --------------------------------------------------
 *
 * The Director/Head of Procurement receives the requisition first and can
 * assign the market-survey work to a Principal/Senior Procurement Officer
 * or Procurement Officer I/II. This models the internal PMU workflow
 * without modelling vendor/tender execution in this application.
 */
export async function assignProcurementOfficer({
  requisitionId,
  assigningUser,
  procurementOfficerId,
  note,
}) {
  const requisition = await Requisition.findById(requisitionId);
  if (!requisition) throw new Error("Requisition not found.");

  const currentStep = requisition.approvalChain?.[requisition.currentStepIndex];
  if (
    !currentStep ||
    currentStep.role !== ROLES.PROCUREMENT ||
    currentStep.type !== "procurement_review"
  ) {
    throw new Error("This requisition is not currently at the Procurement intake stage.");
  }

  const assigner = await User.findById(assigningUser.id);
  if (!assigner || assigner.role !== ROLES.PROCUREMENT) {
    throw new Error("Only authorized Procurement management staff can assign this requisition.");
  }

  if (!PROCUREMENT_ASSIGNMENT_POSITIONS.includes(assigner.procurementPosition)) {
    throw new Error("Your Procurement position is not authorized to assign market-survey work.");
  }

  if (String(currentStep.approver) !== String(assigner._id)) {
    throw new Error("Only the Procurement staff member currently receiving this requisition can assign it.");
  }

  const officer = await User.findOne({
    _id: procurementOfficerId,
    role: ROLES.PROCUREMENT,
    accountStatus: "active",
    procurementPosition: { $in: PROCUREMENT_MARKET_SURVEY_POSITIONS },
  });

  if (!officer) {
    throw new Error("Select an active Principal/Senior Procurement Officer or Procurement Officer I/II.");
  }

  currentStep.approver = officer._id;

  /* The same assigned officer receives the requisition again after VC approval. */
  const processingStep = requisition.approvalChain.find(
    (step) => step.role === ROLES.PROCUREMENT && step.type === "processing"
  );
  if (processingStep) processingStep.approver = officer._id;

  requisition.procurementOfficer = officer._id;
  requisition.procurementAssignedTo = officer._id;
  requisition.procurementAssignedBy = assigner._id;
  requisition.procurementAssignedAt = new Date();
  requisition.procurementStatus = "review";

  requisition.procurementAssignmentHistory.push({
    assignedTo: officer._id,
    assignedBy: assigner._id,
    assignedAt: new Date(),
    note: String(note || "").trim(),
  });

  await requisition.save();

  await AuditLog.create({
    actor: assigner._id,
    action: "requisition.procurement_assigned",
    entityType: "Requisition",
    entityId: requisition._id,
    details: {
      assignedTo: officer._id,
      assignedToPosition: officer.procurementPosition,
      note: String(note || "").trim() || undefined,
    },
  });

  await sendApprovalStepEmail(officer, requisition);

  return requisition;
}

/*
 * --------------------------------------------------
 * PROCUREMENT MARKET-SURVEY REVIEW
 * --------------------------------------------------
 *
 * Procurement may update the effective unit cost of every
 * item after conducting a market survey. The original requester
 * price is preserved on the item for audit/comparison.
 */
export async function updateProcurementReview({
  requisitionId,
  procurementUser,
  items,
  notes,
}) {
  const requisition = await Requisition.findById(requisitionId);

  if (!requisition) {
    throw new Error("Requisition not found.");
  }

  const step = requisition.approvalChain?.[requisition.currentStepIndex];

  if (
    !step ||
    step.role !== ROLES.PROCUREMENT ||
    step.type !== "procurement_review" ||
    String(step.approver) !== String(procurementUser.id)
  ) {
    throw new Error("This requisition is not currently awaiting Procurement market-survey review.");
  }

  if (requisition.status !== REQUISITION_STATUS.PENDING) {
    throw new Error("This requisition is not currently pending review.");
  }

  if (!Array.isArray(items) || items.length !== requisition.items.length) {
    throw new Error("Procurement must provide a market-survey price for every requisition item.");
  }

  let estimatedCost = 0;
  const revision = Number(requisition.procurementRevision || 0) + 1;

  requisition.items.forEach((item, index) => {
    const incoming = items[index];
    const marketUnitCost = Number(incoming?.procurementUnitCost);

    if (!Number.isFinite(marketUnitCost) || marketUnitCost < 0) {
      throw new Error(`Invalid procurement unit cost for item ${index + 1}.`);
    }

    if (item.requestedUnitCost === undefined || item.requestedUnitCost === null) {
      item.requestedUnitCost = Number(item.unitCost || 0);
    }

    if (item.requestedTotalCost === undefined || item.requestedTotalCost === null) {
      item.requestedTotalCost = Number(item.totalCost || 0);
    }

    const previousProcurementUnitCost =
      item.procurementUnitCost === undefined || item.procurementUnitCost === null
        ? undefined
        : Number(item.procurementUnitCost);

    item.procurementUnitCost = marketUnitCost;
    item.unitCost = marketUnitCost;
    item.totalCost = Number(item.quantity || 0) * marketUnitCost;
    item.procurementNote = String(incoming?.procurementNote || "").trim();

    if (!Array.isArray(requisition.procurementPriceHistory)) {
      requisition.procurementPriceHistory = [];
    }
    requisition.procurementPriceHistory.push({
      revision,
      itemName: item.name,
      itemIndex: index,
      requestedUnitCost: Number(item.requestedUnitCost || 0),
      previousProcurementUnitCost,
      procurementUnitCost: marketUnitCost,
      note: item.procurementNote,
      changedBy: procurementUser.id,
      changedAt: new Date(),
    });

    estimatedCost += item.totalCost;
  });

  requisition.estimatedCost = estimatedCost;
  requisition.procurementStatus = "review";
  requisition.procurementOfficer = procurementUser.id;
  requisition.procurementReviewStartedAt ||= new Date();
  requisition.procurementNotes = String(notes || "").trim();
  requisition.procurementRevision = revision;

  await requisition.save();

  await AuditLog.create({
    actor: procurementUser.id,
    action: "requisition.procurement_market_survey_updated",
    entityType: "Requisition",
    entityId: requisition._id,
    details: {
      revision: requisition.procurementRevision,
      estimatedCost,
      notes: requisition.procurementNotes,
    },
  });

  return requisition;
}

/*
 * --------------------------------------------------
 * PROCUREMENT SUBMITS MARKET-SURVEYED REQUISITION TO VC
 * --------------------------------------------------
 */
export async function submitProcurementToVc({
  requisitionId,
  procurementUser,
  comment,
}) {
  const requisition = await Requisition.findById(requisitionId);

  if (!requisition) {
    throw new Error("Requisition not found.");
  }

  const step = requisition.approvalChain?.[requisition.currentStepIndex];

  if (
    !step ||
    step.role !== ROLES.PROCUREMENT ||
    step.type !== "procurement_review" ||
    String(step.approver) !== String(procurementUser.id)
  ) {
    throw new Error("This requisition is not currently awaiting Procurement market-survey review.");
  }

  if (requisition.status !== REQUISITION_STATUS.PENDING) {
    throw new Error("This requisition is not currently pending review.");
  }

  const incomplete = requisition.items.some(
    (item) =>
      item.procurementUnitCost === undefined ||
      item.procurementUnitCost === null
  );

  if (incomplete) {
    throw new Error("Complete the market-survey price for every item before sending the requisition to the VC.");
  }

  const nextIndex = requisition.currentStepIndex + 1;
  const nextStep = requisition.approvalChain[nextIndex];

  if (!nextStep || nextStep.role !== ROLES.VC || nextStep.type !== "approval") {
    throw new Error("The requisition does not have a valid VC approval step after Procurement.");
  }

  requisition.currentStepIndex = nextIndex;
  requisition.procurementStatus = "submitted_to_vc";
  requisition.submittedToVcAt = new Date();
  requisition.status = REQUISITION_STATUS.PENDING;

  if (comment?.trim()) {
    requisition.comments.push({
      author: procurementUser.id,
      message: comment.trim(),
    });
  }

  await requisition.save();

  await syncConsolidatedSourcesAfterApproval({
    representative: requisition,
    approvedStep: step,
    approverId: procurementUser.id,
    comment,
    recordApproval: false,
  });

  await AuditLog.create({
    actor: procurementUser.id,
    action: "requisition.procurement_submitted_to_vc",
    entityType: "Requisition",
    entityId: requisition._id,
    details: {
      fromStepIndex: requisition.currentStepIndex - 1,
      toStepIndex: nextIndex,
      estimatedCost: requisition.estimatedCost,
      comment: comment?.trim() || undefined,
    },
  });

  const vc = await User.findById(nextStep.approver);
  if (vc) {
    await sendApprovalStepEmail(vc, requisition);
  }

  return requisition;
}


/*
 * --------------------------------------------------
 * PROCUREMENT FINAL PROCESSING
 * --------------------------------------------------
 */
export async function updateProcurementProcessing({
  requisitionId,
  procurementUser,
  action,
  comment,
}) {
  const requisition = await Requisition.findById(requisitionId);

  if (!requisition) {
    throw new Error("Requisition not found.");
  }

  const step = requisition.approvalChain?.[requisition.currentStepIndex];

  if (
    !step ||
    step.role !== ROLES.PROCUREMENT ||
    step.type !== "processing" ||
    String(step.approver) !== String(procurementUser.id)
  ) {
    throw new Error("This requisition is not currently assigned to you for Procurement processing.");
  }

  if (requisition.status !== REQUISITION_STATUS.APPROVED) {
    throw new Error("Only VC-approved requisitions can enter Procurement processing.");
  }

  if (!["start", "complete"].includes(action)) {
    throw new Error("Invalid Procurement processing action.");
  }

  if (action === "start") {
    if (!["ready", "processing"].includes(requisition.procurementStatus)) {
      throw new Error("This requisition is not ready for Procurement processing.");
    }
    requisition.procurementStatus = "processing";
    requisition.procurementStartedAt ||= new Date();
  } else {
    if (requisition.procurementStatus !== "processing") {
      throw new Error("Start Procurement processing before completing it.");
    }
    requisition.procurementStatus = "completed";
    requisition.procurementCompletedAt = new Date();
  }

  if (comment?.trim()) {
    requisition.comments.push({
      author: procurementUser.id,
      message: comment.trim(),
    });
  }

  await requisition.save();

  await AuditLog.create({
    actor: procurementUser.id,
    action: `requisition.procurement_${action}`,
    entityType: "Requisition",
    entityId: requisition._id,
    details: {
      procurementStatus: requisition.procurementStatus,
      comment: comment?.trim() || undefined,
    },
  });

  return requisition;
}

/*
 * --------------------------------------------------
 * RETURN FOR CLARIFICATION
 * --------------------------------------------------
 */
export async function returnStep({
  requisitionId,
  approverUser,
  comment,
}) {
  const requisition =
    await loadAndVerifyStep(
      requisitionId,
      approverUser.id
    );

  const step =
    requisition.approvalChain[
      requisition.currentStepIndex
    ];

  await Approval.create({
    requisition:
      requisition._id,

    stepIndex:
      requisition.currentStepIndex,

    role:
      step.role,

    approver:
      approverUser.id,

    action:
      APPROVAL_ACTIONS.RETURN,

    comment,
  });

  /*
   * First approval step:
   * return directly to requester.
   */
  if (
    requisition.currentStepIndex ===
    0
  ) {
    requisition.awaitingRequesterAction =
      true;
  }

  /*
   * Otherwise return to previous
   * approval authority.
   */
  else {
    requisition.currentStepIndex -=
      1;

    requisition.awaitingRequesterAction =
      false;
  }

  requisition.status =
    REQUISITION_STATUS.RETURNED;

  /*
   * If Procurement somehow returns a processing
   * stage, reset procurement status.
   */
  if (
    requisition.procurementStatus
  ) {
    requisition.procurementStatus =
      undefined;

    requisition.procurementOfficer =
      undefined;

    requisition.procurementReceivedAt =
      undefined;
  }

  if (comment) {
    requisition.comments.push({
      author:
        approverUser.id,

      message:
        comment,
    });
  }

  await requisition.save();

  await AuditLog.create({
    actor:
      approverUser.id,

    action:
      "requisition.return",

    entityType:
      "Requisition",

    entityId:
      requisition._id,

    details: {
      comment,
    },
  });

  await sendRequisitionReturnedEmail(
    requisition.requester,
    requisition,
    comment
  );

  /*
   * Notify previous approver.
   */
  if (
    !requisition.awaitingRequesterAction
  ) {
    const previousStep =
      requisition.approvalChain[
        requisition.currentStepIndex
      ];

    if (
      previousStep?.approver
    ) {
      const previousApprover =
        await User.findById(
          previousStep.approver
        );

      if (previousApprover) {
        await sendApprovalStepEmail(
          previousApprover,
          requisition
        );
      }
    }
  }

  return requisition;
}

/*
 * --------------------------------------------------
 * REJECT REQUISITION
 * --------------------------------------------------
 */
export async function rejectStep({
  requisitionId,
  approverUser,
  comment,
  isFinal,
}) {
  const requisition =
    await loadAndVerifyStep(
      requisitionId,
      approverUser.id
    );

  const step =
    requisition.approvalChain[
      requisition.currentStepIndex
    ];

  await Approval.create({
    requisition:
      requisition._id,

    stepIndex:
      requisition.currentStepIndex,

    role:
      step.role,

    approver:
      approverUser.id,

    action:
      APPROVAL_ACTIONS.REJECT,

    comment,
  });

  /*
   * Final rejection.
   */
  if (isFinal) {
    requisition.status =
      REQUISITION_STATUS.REJECTED;

    requisition.decidedAt =
      new Date();

    requisition.awaitingRequesterAction =
      false;
  }

  /*
   * Non-final rejection:
   * send back to requester for editing.
   */
  else {
    requisition.status =
      REQUISITION_STATUS.RETURNED;

    requisition.awaitingRequesterAction =
      true;

    requisition.currentStepIndex =
      0;
  }

  /*
   * Clear Procurement state if the
   * requisition is sent backward.
   */
  requisition.procurementStatus =
    undefined;

  requisition.procurementOfficer =
    undefined;

  requisition.procurementReceivedAt =
    undefined;

  requisition.procurementStartedAt =
    undefined;

  requisition.procurementCompletedAt =
    undefined;

  if (comment) {
    requisition.comments.push({
      author:
        approverUser.id,

      message:
        comment,
    });
  }

  await requisition.save();

  await AuditLog.create({
    actor:
      approverUser.id,

    action:
      "requisition.reject",

    entityType:
      "Requisition",

    entityId:
      requisition._id,

    details: {
      isFinal,
      comment,
    },
  });

  await sendRequisitionRejectedEmail(
    requisition.requester,
    requisition,
    comment
  );

  return requisition;
    }

/*
 * --------------------------------------------------
 * SHARED HELPERS FOR PARTIAL RESOLUTION
 * --------------------------------------------------
 */

/*
 * Derives requestingUnits + the top-level
 * collegeId/facultyId/department/isConsolidated from a
 * set of items — the same derivation used everywhere a
 * consolidated requisition is created, split, or shrunk.
 *
 * Only meaningful for items that actually carry
 * requestingCollegeId/FacultyId/Department (i.e. items
 * that came from a consolidation). A plain, non-consolidated
 * requisition's items never have these — callers must use
 * the requisition's own top-level org fields instead; see
 * the `wasConsolidated` guard in recomputeOrClose() below.
 */
function deriveOrganizationFromItems(items) {
  const unitMap = new Map();

  for (const item of items) {
    const key = [
      item.requestingCollegeId,
      item.requestingFacultyId,
      item.requestingDepartment,
    ].join("|");

    if (!unitMap.has(key)) {
      unitMap.set(key, {
        collegeId: item.requestingCollegeId,
        facultyId: item.requestingFacultyId,
        department: item.requestingDepartment,
      });
    }
  }

  const requestingUnits = [...unitMap.values()];

  const distinctColleges = [
    ...new Set(requestingUnits.map((u) => u.collegeId)),
  ];

  const distinctFaculties = [
    ...new Set(requestingUnits.map((u) => u.facultyId)),
  ];

  return {
    requestingUnits,
    collegeId:
      distinctColleges.length === 1 ? distinctColleges[0] : "N/A",
    facultyId:
      distinctColleges.length === 1 && distinctFaculties.length === 1
        ? distinctFaculties[0]
        : "N/A",
    department:
      requestingUnits.length === 1 ? requestingUnits[0].department : "N/A",
    isConsolidated: requestingUnits.length > 1,
  };
}

/*
 * Fully detaches a source requisition that's ENTIRELY being
 * split off (every one of its merged items is leaving).
 *
 * "return": revives the source exactly as it was — its own
 * status/approvalChain/currentStepIndex are untouched, since
 * consolidating never changed them in the first place — so
 * it lands back with whichever approver it was already
 * waiting on.
 *
 * "reject": terminates it, exactly like a normal final
 * rejection.
 *
 * Caller is responsible for having already removed the
 * source from requisition.sourceRequisitions/items.
 */
async function resolveFullyDetachedSource({
  requisitionForApproval,
  sourceRequisitionId,
  approverUser,
  action,
  comment,
  step,
}) {
  const source = await Requisition.findById(
    sourceRequisitionId
  ).populate("requester");

  if (!source) {
    throw new Error("Source requisition not found.");
  }

  source.comments.push({
    author: approverUser.id,
    message: comment,
  });

  if (action === "return") {
    source.consolidatedInto = undefined;
    source.consolidatedAt = undefined;

    await source.save();

    await Approval.create({
      requisition: requisitionForApproval._id,
      stepIndex: requisitionForApproval.currentStepIndex,
      role: step.role,
      approver: approverUser.id,
      action: APPROVAL_ACTIONS.RETURN,
      comment,
    });

    await sendRequisitionReturnedEmail(source.requester, source, comment);

    const sourceStep = source.approvalChain[source.currentStepIndex];

    if (sourceStep?.approver) {
      const sourceApprover = await User.findById(sourceStep.approver);

      if (sourceApprover) {
        await sendApprovalStepEmail(sourceApprover, source);
      }
    }
  } else {
    source.status = REQUISITION_STATUS.REJECTED;
    source.decidedAt = new Date();
    source.awaitingRequesterAction = false;
    source.consolidatedInto = undefined;
    source.consolidatedAt = undefined;
    source.procurementStatus = undefined;
    source.procurementOfficer = undefined;
    source.procurementReceivedAt = undefined;

    await source.save();

    await Approval.create({
      requisition: requisitionForApproval._id,
      stepIndex: requisitionForApproval.currentStepIndex,
      role: step.role,
      approver: approverUser.id,
      action: APPROVAL_ACTIONS.REJECT,
      comment,
    });

    await sendRequisitionRejectedEmail(source.requester, source, comment);
  }

  return source;
}

/*
 * Recomputes a shrunk requisition's organization/cost from
 * whatever items remain, or closes it out (REJECTED) if
 * nothing remains. Mutates `requisition` in place; caller
 * saves it.
 */
function recomputeOrClose(requisition, approverUser, emptyMessage) {
  if (requisition.items.length === 0) {
    requisition.status = REQUISITION_STATUS.REJECTED;
    requisition.decidedAt = new Date();
    requisition.awaitingRequesterAction = false;
    requisition.comments.push({
      author: approverUser.id,
      message: emptyMessage,
    });
    return true;
  }

  /*
   * A plain, non-consolidated requisition's items never
   * carry requestingCollegeId/FacultyId/Department — its
   * top-level collegeId/facultyId/department already
   * correctly describe it and must be left alone. Only a
   * requisition that WAS consolidated needs its org fields
   * re-derived from what's left.
   */
  if (!requisition.isConsolidated) {
    requisition.estimatedCost = requisition.items.reduce(
      (sum, item) => sum + Number(item.totalCost || 0),
      0
    );
    return false;
  }

  const org = deriveOrganizationFromItems(requisition.items);

  requisition.requestingUnits = org.requestingUnits;
  requisition.collegeId = org.collegeId;
  requisition.facultyId = org.facultyId;
  requisition.department = org.department;
  requisition.isConsolidated = org.isConsolidated;

  requisition.estimatedCost = requisition.items.reduce(
    (sum, item) => sum + Number(item.totalCost || 0),
    0
  );

  return false;
}

/*
 * --------------------------------------------------
 * PARTIAL RESOLVE — WHOLE SOURCE (consolidated only)
 * --------------------------------------------------
 *
 * Lets the CURRENT approver on a pending consolidated
 * requisition split off ONE source requisition instead of
 * deciding on the whole merged batch at once — e.g. a
 * Provost approving 4 of 6 merged departments while
 * sending the other 2 back.
 *
 * The remaining consolidated requisition stays PENDING at
 * the SAME step — the approver can keep splitting, or
 * fully approve what's left. If nothing is left, the
 * consolidated requisition itself is closed out.
 */
export async function partialResolveSource({
  requisitionId,
  approverUser,
  sourceRequisitionId,
  action,
  comment,
}) {
  if (action !== "return" && action !== "reject") {
    throw new Error("Invalid action.");
  }

  if (!comment?.trim()) {
    throw new Error("A comment is required.");
  }

  const requisition = await loadAndVerifyStep(
    requisitionId,
    approverUser.id
  );

  if (!requisition.isConsolidated) {
    throw new Error(
      "This requisition is not a consolidated requisition."
    );
  }

  const stillIncluded = requisition.sourceRequisitions.some(
    (id) => String(id) === String(sourceRequisitionId)
  );

  if (!stillIncluded) {
    throw new Error(
      "That requisition is not part of this consolidation."
    );
  }

  const step = requisition.approvalChain[requisition.currentStepIndex];

  requisition.sourceRequisitions = requisition.sourceRequisitions.filter(
    (id) => String(id) !== String(sourceRequisitionId)
  );

  requisition.items = requisition.items.filter(
    (item) =>
      String(item.sourceRequisitionId) !== String(sourceRequisitionId)
  );

  const source = await resolveFullyDetachedSource({
    requisitionForApproval: requisition,
    sourceRequisitionId,
    approverUser,
    action,
    comment,
    step,
  });

  await AuditLog.create({
    actor: approverUser.id,
    action: "requisition.consolidated_partial_" + action,
    entityType: "Requisition",
    entityId: requisition._id,
    details: {
      sourceRequisitionId: String(sourceRequisitionId),
      comment,
    },
  });

  const closed = recomputeOrClose(
    requisition,
    approverUser,
    "Consolidated requisition closed automatically — no requisitions remain after being handled separately."
  );

  await requisition.save();

  return { requisition, source, closed };
}

/*
 * --------------------------------------------------
 * PARTIAL RESOLVE — INDIVIDUAL ITEMS
 * --------------------------------------------------
 *
 * Lets the CURRENT approver split off specific ITEMS
 * (not necessarily a whole source) and return or reject
 * just those — e.g. a HOD's 10-item requisition where the
 * next approver wants to approve 7 and send 3 back, or a
 * consolidated requisition where only some of one
 * department's items are the problem.
 *
 * Each selected item is grouped by which source it traces
 * back to ("self" for a plain, non-consolidated
 * requisition's own items — those items don't carry
 * requestingCollegeId/etc., so the parent's own top-level
 * org fields are used instead). Every group becomes a
 * brand-new split-off requisition, belonging to that
 * group's original requester:
 *
 *  - "reject": terminated immediately (REJECTED).
 *  - "return": sent straight to the requester — RETURNED,
 *    awaitingRequesterAction: true, currentStepIndex: 0 —
 *    editable and resubmittable, exactly like a normal
 *    non-final rejection. This is deliberately the same
 *    outcome whether the group is a whole source or only
 *    part of one, so the behavior never depends on how
 *    much of a department's items happened to be selected.
 *
 * The parent requisition stays PENDING at the SAME step
 * with the remaining items. If nothing is left, it's
 * closed out the same way a fully-split consolidation is.
 */
export async function partialResolveItems({
  requisitionId,
  approverUser,
  itemIndexes,
  action,
  comment,
}) {
  if (action !== "return" && action !== "reject") {
    throw new Error("Invalid action.");
  }

  if (!comment?.trim()) {
    throw new Error("A comment is required.");
  }

  if (!Array.isArray(itemIndexes) || itemIndexes.length === 0) {
    throw new Error("Select at least one item.");
  }

  const requisition = await loadAndVerifyStep(
    requisitionId,
    approverUser.id
  );

  const step = requisition.approvalChain[requisition.currentStepIndex];

  const indexSet = new Set(itemIndexes.map(Number));

  const invalidIndex = [...indexSet].some(
    (i) => !Number.isInteger(i) || i < 0 || i >= requisition.items.length
  );

  if (invalidIndex) {
    throw new Error("One or more selected items are invalid.");
  }

  if (indexSet.size >= requisition.items.length) {
    throw new Error(
      "You can't split off every item this way — use Return/Reject on the whole requisition instead."
    );
  }

  const splitItems = requisition.items.filter((_, i) => indexSet.has(i));
  const keptItems = requisition.items.filter((_, i) => !indexSet.has(i));

  // Whether the PARENT itself carries requestingCollegeId/etc. on its
  // items (a consolidated requisition) or not (a plain requisition,
  // where org info lives only at the top level) — decides how each
  // group's org fields get resolved below.
  const parentWasConsolidated = requisition.isConsolidated;
  const parentOwnOrg = {
    collegeId: requisition.collegeId,
    facultyId: requisition.facultyId,
    department: requisition.department,
  };

  // Snapshot before mutating — used as the starting approvalChain shown
  // on each new split-off record before it's actually resubmitted (the
  // real chain gets rebuilt from scratch on resubmit regardless).
  const parentChainSnapshot = requisition.approvalChain.map((s) => ({
    role: s.role,
    approver: s.approver,
    type: s.type,
  }));

  requisition.items = keptItems;

  /*
   * Group by which source each item traces back to —
   * "self" for a plain requisition's own items.
   */
  const groups = new Map();

  for (const item of splitItems) {
    const key = item.sourceRequisitionId
      ? String(item.sourceRequisitionId)
      : "self";

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(item);
  }

  // A source fully split off also needs to come out of
  // sourceRequisitions, same as the whole-source case.
  for (const key of groups.keys()) {
    if (key === "self") continue;

    const stillMerged = requisition.items.some(
      (item) => String(item.sourceRequisitionId) === key
    );

    if (!stillMerged) {
      requisition.sourceRequisitions =
        requisition.sourceRequisitions.filter(
          (id) => String(id) !== key
        );
    }
  }

  const results = [];

  for (const [key, groupItems] of groups) {
    let requesterId = requisition.requester._id || requisition.requester;
    let requesterRole = requisition.requesterRole;

    if (key !== "self") {
      const sourceDoc = await Requisition.findById(key).select(
        "requester requesterRole"
      );

      if (sourceDoc) {
        requesterId = sourceDoc.requester;
        requesterRole = sourceDoc.requesterRole;
      }
    }

    // "self" items never carry their own org fields — use the
    // parent's; source-derived items do carry them.
    const org =
      key === "self"
        ? parentOwnOrg
        : deriveOrganizationFromItems(groupItems);

    const estimatedCost = groupItems.reduce(
      (sum, item) => sum + Number(item.totalCost || 0),
      0
    );

    const now = new Date();

    const outcomeFields =
      action === "reject"
        ? {
            status: REQUISITION_STATUS.REJECTED,
            decidedAt: now,
            awaitingRequesterAction: false,
            currentStepIndex: 0,
          }
        : {
            status: REQUISITION_STATUS.RETURNED,
            awaitingRequesterAction: true,
            currentStepIndex: 0,
          };

    const child = await Requisition.create({
      requester: requesterId,
      requesterRole,
      isConsolidated: false,
      collegeId: org.collegeId === "N/A" ? undefined : org.collegeId,
      facultyId: org.facultyId === "N/A" ? undefined : org.facultyId,
      department: org.department === "N/A" ? undefined : org.department,
      category: requisition.category,
      purpose: requisition.purpose,
      urgency: requisition.urgency,
      items: groupItems,
      estimatedCost,
      requisitionNumber: await generateRequisitionNumber(),
      submittedAt: now,
      approvalChain: parentChainSnapshot,
      comments: [
        {
          author: approverUser.id,
          message: comment,
        },
      ],
      ...outcomeFields,
    });

    await Approval.create({
      requisition: requisition._id,
      stepIndex: requisition.currentStepIndex,
      role: step.role,
      approver: approverUser.id,
      action:
        action === "reject"
          ? APPROVAL_ACTIONS.REJECT
          : APPROVAL_ACTIONS.RETURN,
      comment,
    });

    const populatedChild = await Requisition.findById(
      child._id
    ).populate("requester");

    if (action === "reject") {
      await sendRequisitionRejectedEmail(
        populatedChild.requester,
        populatedChild,
        comment
      );
    } else {
      await sendRequisitionReturnedEmail(
        populatedChild.requester,
        populatedChild,
        comment
      );
    }

    results.push(populatedChild);
  }

  await AuditLog.create({
    actor: approverUser.id,
    action: "requisition.partial_items_" + action,
    entityType: "Requisition",
    entityId: requisition._id,
    details: {
      itemIndexes: [...indexSet],
      splitInto: results.map((r) => String(r._id)),
      comment,
    },
  });

  const closed = recomputeOrClose(
    requisition,
    approverUser,
    "Requisition closed automatically — no items remain after being handled separately."
  );

  await requisition.save();

  return { requisition, splitInto: results, closed };
}
