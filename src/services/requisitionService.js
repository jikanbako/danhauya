import Requisition from "@/models/Requisition";
import AuditLog from "@/models/AuditLog";
import User from "@/models/User";

import {
  buildApprovalChain,
  isEscalated,
} from "@/lib/routing";

import {
  REQUISITION_STATUS,
} from "@/constants/requisitionOptions";

import { ROLES } from "@/constants/roles";

import {
  getCollegeById,
  getFaculty,
} from "@/constants/colleges";

import {
  sendRequisitionSubmittedEmail,
  sendApprovalStepEmail,
} from "@/lib/mailer";

/*
 * --------------------------------------------------
 * ITEM TOTALS
 * --------------------------------------------------
 */

function computeItemTotals(
  items = []
) {
  return items.map((item) => ({
    ...item,

    totalCost:
      Number(item.quantity || 0) *
      Number(item.unitCost || 0),
  }));
}

function sumEstimatedCost(
  items = []
) {
  return items.reduce(
    (sum, item) =>
      sum +
      Number(
        item.totalCost || 0
      ),
    0
  );
}

/*
 * --------------------------------------------------
 * REQUISITION NUMBER
 * --------------------------------------------------
 */

export async function generateRequisitionNumber() {
  const year =
    new Date().getFullYear();

  const count =
    await Requisition.countDocuments(
      {
        requisitionNumber: {
          $regex: `^KSU/REQ/${year}/`,
        },
      }
    );

  const seq = String(
    count + 1
  ).padStart(4, "0");

  return `KSU/REQ/${year}/${seq}`;
}

/*
 * --------------------------------------------------
 * ORGANIZATION
 * --------------------------------------------------
 *
 * Normal requester:
 *
 *   User's own organization
 *
 * Procurement:
 *
 *   Organization selected in the form
 *
 * This is the key Option B change.
 */

function unitKey(unit) {
  return [
    unit.collegeId,
    unit.facultyId,
    unit.department,
  ].join("|");
}

/*
 * Derive a shared collegeId/facultyId across a set of
 * requesting units when they agree, even if department
 * differs — "N/A" only when the units genuinely disagree
 * (e.g. Procurement/VC spanning multiple colleges), where
 * routing doesn't need a single college anyway. Mirrors the
 * same derivation used by the consolidate-existing-requisitions
 * endpoint.
 */
function deriveCommonCollegeFaculty(units) {
  const distinctColleges = [
    ...new Set(
      units.map((u) => u.collegeId)
    ),
  ];

  const distinctFaculties = [
    ...new Set(
      units.map((u) => u.facultyId)
    ),
  ];

  const commonCollegeId =
    distinctColleges.length === 1
      ? distinctColleges[0]
      : "N/A";

  const commonFacultyId =
    distinctColleges.length === 1 &&
    distinctFaculties.length === 1
      ? distinctFaculties[0]
      : "N/A";

  return {
    commonCollegeId,
    commonFacultyId,
  };
}

/*
 * Procurement/Dean/Provost can each pick one or more
 * requesting units (College/Faculty/Department) for a
 * requisition:
 *
 *  - Procurement: fully open, university-wide.
 *  - Dean: college + faculty locked to their own; only
 *    department varies, validated against their faculty.
 *  - Provost: college locked to their own; faculty and
 *    department vary, validated against their college.
 *
 * Every unit is re-validated here against the requester's
 * own scope regardless of what the client sends. When more
 * than one unit is picked, the requisition is effectively a
 * consolidated requisition (isConsolidated: true) and every
 * item must be tagged with which unit it belongs to — that
 * item-level check happens in submitRequisition().
 */
function getRequestingOrganization({
  requesterUser,
  payload,
}) {
  const isProcurement =
    requesterUser.role ===
    ROLES.PROCUREMENT;

  const isDean =
    requesterUser.role ===
    ROLES.DEAN;

  const isProvost =
    requesterUser.role ===
    ROLES.PROVOST;

  const canPickOrganization =
    isProcurement ||
    isDean ||
    isProvost;

  if (!canPickOrganization) {
    return {
      collegeId:
        requesterUser.collegeId,

      facultyId:
        requesterUser.facultyId,

      department:
        requesterUser.department,

      isConsolidated: false,

      requestingUnits: [],
    };
  }

  const rawUnits = Array.isArray(
    payload.requestingUnits
  )
    ? payload.requestingUnits
    : [];

  const units = rawUnits.map((unit) => {
    if (isProcurement) {
      const faculty = getFaculty(
        unit.collegeId,
        unit.facultyId
      );

      if (
        !faculty?.departments?.includes(
          unit.department
        )
      ) {
        throw new Error(
          "One of the selected requesting units is invalid."
        );
      }

      return {
        collegeId: unit.collegeId,
        facultyId: unit.facultyId,
        department: unit.department,
      };
    }

    if (isDean) {
      const faculty = getFaculty(
        requesterUser.collegeId,
        requesterUser.facultyId
      );

      if (
        !faculty?.departments?.includes(
          unit.department
        )
      ) {
        throw new Error(
          "Selected department is not part of your faculty."
        );
      }

      return {
        collegeId:
          requesterUser.collegeId,

        facultyId:
          requesterUser.facultyId,

        department: unit.department,
      };
    }

    // isProvost
    const faculty = getFaculty(
      requesterUser.collegeId,
      unit.facultyId
    );

    if (!faculty) {
      throw new Error(
        "Selected faculty is not part of your college."
      );
    }

    if (
      !faculty.departments?.includes(
        unit.department
      )
    ) {
      throw new Error(
        "Selected department is not part of the selected faculty."
      );
    }

    return {
      collegeId:
        requesterUser.collegeId,

      facultyId: unit.facultyId,
      department: unit.department,
    };
  });

  /*
   * Nothing selected yet — still drafting. Fall back to a
   * sensible default so the draft is still valid to save.
   */
  if (units.length === 0) {
    if (isProcurement) {
      return {
        collegeId: "N/A",
        facultyId: "N/A",
        department: "N/A",
        isConsolidated: false,
        requestingUnits: [],
      };
    }

    return {
      collegeId:
        requesterUser.collegeId,

      facultyId:
        requesterUser.facultyId,

      department:
        requesterUser.department,

      isConsolidated: false,

      requestingUnits: [],
    };
  }

  if (units.length === 1) {
    return {
      collegeId: units[0].collegeId,
      facultyId: units[0].facultyId,
      department: units[0].department,
      isConsolidated: false,
      requestingUnits: units,
    };
  }

  const {
    commonCollegeId,
    commonFacultyId,
  } = deriveCommonCollegeFaculty(units);

  return {
    collegeId: commonCollegeId,
    facultyId: commonFacultyId,
    department: "N/A",
    isConsolidated: true,
    requestingUnits: units,
  };
  }

/*
 * --------------------------------------------------
 * SAVE DRAFT
 * --------------------------------------------------
 */

export async function saveDraft({
  requisitionId,
  requesterUser,
  payload,
}) {
  const items =
    computeItemTotals(
      payload.items || []
    );

  const estimatedCost =
    sumEstimatedCost(items);

  const organization =
    getRequestingOrganization({
      requesterUser,
      payload,
    });

  const data = {
    category:
      payload.category,

    purpose:
      payload.purpose,

    urgency:
      payload.urgency,

    items,

    estimatedCost,

    requesterRole:
      requesterUser.role,

    collegeId:
      organization.collegeId,

    facultyId:
      organization.facultyId,

    department:
      organization.department,

    isConsolidated:
      organization.isConsolidated,

    requestingUnits:
      organization.requestingUnits,
  };

  let requisition;

  /*
   * --------------------------------------------------
   * UPDATE
   * --------------------------------------------------
   */

  if (requisitionId) {
    requisition =
      await Requisition.findOne({
        _id: requisitionId,

        requester:
          requesterUser.id,
      });

    if (!requisition) {
      throw new Error(
        "Requisition not found."
      );
    }

    const editable =
      requisition.status ===
        REQUISITION_STATUS.DRAFT ||
      (
        requisition.status ===
          REQUISITION_STATUS.RETURNED &&
        requisition.awaitingRequesterAction
      );

    if (!editable) {
      throw new Error(
        "This requisition is not editable."
      );
    }

    requisition.category =
      data.category;

    requisition.purpose =
      data.purpose;

    requisition.urgency =
      data.urgency;

    requisition.items =
      data.items;

    requisition.estimatedCost =
      data.estimatedCost;

/*
     * Only Procurement/Dean/Provost may update
     * the requesting organization from the
     * requisition form.
     *
     * For normal users, preserve the
     * original organizational snapshot.
     */
    if (
      requesterUser.role ===
        ROLES.PROCUREMENT ||
      requesterUser.role ===
        ROLES.DEAN ||
      requesterUser.role ===
        ROLES.PROVOST
    ) {
      requisition.collegeId =
        data.collegeId;

      requisition.facultyId =
        data.facultyId;

      requisition.department =
        data.department;

      requisition.isConsolidated =
        data.isConsolidated;

      requisition.requestingUnits =
        data.requestingUnits;
    }

    if (
      !requisition.requesterRole
    ) {
      requisition.requesterRole =
        requesterUser.role;
    }

    /*
     * Returned → Draft.
     */
    if (
      requisition.status ===
        REQUISITION_STATUS.RETURNED &&
      requisition.awaitingRequesterAction
    ) {
      requisition.status =
        REQUISITION_STATUS.DRAFT;

      requisition.awaitingRequesterAction =
        false;
    }

    await requisition.save();
  }

  /*
   * --------------------------------------------------
   * CREATE
   * --------------------------------------------------
   */

  else {
    requisition =
      await Requisition.create({
        ...data,

        requester:
          requesterUser.id,

        status:
          REQUISITION_STATUS.DRAFT,
      });
  }

  await AuditLog.create({
    actor:
      requesterUser.id,

    action:
      requisitionId
        ? "requisition.draft_update"
        : "requisition.draft_create",

    entityType:
      "Requisition",

    entityId:
      requisition._id,

    details: {
      requesterRole:
        requesterUser.role,

      requestingCollege:
        requisition.collegeId,

      requestingFaculty:
        requisition.facultyId,

      requestingDepartment:
        requisition.department,
    },
  });

  return requisition;
}

/*
 * --------------------------------------------------
 * SUBMIT
 * --------------------------------------------------
 */

export async function submitRequisition({
  requisitionId,
  requesterUser,
}) {
  const requisition =
    await Requisition.findOne({
      _id: requisitionId,

      requester:
        requesterUser.id,
    });

  if (!requisition) {
    throw new Error(
      "Requisition not found."
    );
  }

  const isFreshDraft =
    requisition.status ===
    REQUISITION_STATUS.DRAFT;

  const isReturnedToRequester =
    requisition.status ===
      REQUISITION_STATUS.RETURNED &&
    requisition.awaitingRequesterAction;

  if (
    !isFreshDraft &&
    !isReturnedToRequester
  ) {
    throw new Error(
      "This requisition is not awaiting your submission."
    );
  }

  /*
   * --------------------------------------------------
   * REQUESTING ORGANIZATION VALIDATION
   * --------------------------------------------------
   *
   * Procurement, Dean and Provost must explicitly select
   * at least one requesting organization before submitting.
   * When more than one is selected, every item must be
   * tagged with which one it belongs to — that's what
   * makes it possible to preserve each item's originating
   * department through a multi-unit requisition.
   */

  const canPickOrganization =
    requesterUser.role ===
      ROLES.PROCUREMENT ||
    requesterUser.role ===
      ROLES.DEAN ||
    requesterUser.role ===
      ROLES.PROVOST;

  if (canPickOrganization) {
    const units =
      requisition.requestingUnits ||
      [];

    if (units.length === 0) {
      throw new Error(
        "Please select at least one requesting College, Faculty and Department before submitting."
      );
    }

    if (units.length > 1) {
      const validKeys = new Set(
        units.map(unitKey)
      );

      const untaggedItem =
        requisition.items.find(
          (item) => {
            const key = [
              item.requestingCollegeId,
              item.requestingFacultyId,
              item.requestingDepartment,
            ].join("|");

            return !validKeys.has(
              key
            );
          }
        );

      if (untaggedItem) {
        throw new Error(
          "Every item must be tagged with one of the selected requesting departments."
        );
      }
    }
  }

  /*
   * Make sure older records have
   * requesterRole.
   */

  if (
    !requisition.requesterRole
  ) {
    requisition.requesterRole =
      requesterUser.role;
  }

  /*
   * --------------------------------------------------
   * BUILD APPROVAL CHAIN
   * --------------------------------------------------
   */

  /*
   * V6: a Procurement-created consolidation is not an ordinary
   * Procurement-authored requisition. Its source requisitions may already
   * be approved, but the NEW consolidated record still needs Procurement
   * market-survey review before its own VC decision.
   */
  const routingRequesterRole =
    requisition.isConsolidated &&
    requisition.requesterRole === ROLES.PROCUREMENT
      ? ROLES.PROVOST
      : requisition.requesterRole;

  const {
    chain,
    requiresGovernorApproval,
  } =
    await buildApprovalChain({
      requesterRole:
        routingRequesterRole,

      requesterId:
        requisition.requester,

      collegeId:
        requisition.collegeId,

      facultyId:
        requisition.facultyId,

      department:
        requisition.department,

      estimatedCost:
        requisition.estimatedCost,
    });

  requisition.approvalChain =
    chain;

  requisition.requiresGovernorApproval =
    requiresGovernorApproval;

  requisition.currentStepIndex =
    0;

  requisition.awaitingRequesterAction =
    false;

  requisition.status =
    REQUISITION_STATUS.PENDING;

  requisition.submittedAt =
    new Date();

  requisition.finalApprovalAt =
    undefined;

  requisition.procurementReceivedAt =
    undefined;

  requisition.procurementStartedAt =
    undefined;

  requisition.procurementCompletedAt =
    undefined;

  /*
   * Generate number only once.
   */

  if (
    !requisition.requisitionNumber
  ) {
    requisition.requisitionNumber =
      await generateRequisitionNumber();
  }

  /*
   * Procurement requisitions should
   * start without an active processing
   * status because they are still waiting
   * for VC approval.
   */

  requisition.procurementStatus =
    undefined;

  requisition.procurementOfficer =
    undefined;

  await requisition.save();

  await AuditLog.create({
    actor:
      requesterUser.id,

    action:
      "requisition.submit",

    entityType:
      "Requisition",

    entityId:
      requisition._id,

    details: {
      requesterRole:
        requisition.requesterRole,

      requestingCollege:
        requisition.collegeId,

      requestingFaculty:
        requisition.facultyId,

      requestingDepartment:
        requisition.department,

      requiresGovernorApproval,

      resubmission:
        isReturnedToRequester,
    },
  });

  await sendRequisitionSubmittedEmail(
    requesterUser,
    requisition
  );

  /*
   * Notify first approval authority.
   */

  const firstStep =
    chain[0];

  if (
    firstStep?.approver
  ) {
    const approver =
      await User.findById(
        firstStep.approver
      );

    if (approver) {
      await sendApprovalStepEmail(
        approver,
        requisition
      );
    }
  }

  return requisition;
}

/*
 * --------------------------------------------------
 * CREATE CONSOLIDATED REQUISITION
 * --------------------------------------------------
 *
 * Used by:
 *
 * Dean
 * Provost
 * VC
 * Procurement
 *
 * A consolidated requisition combines the items from
 * multiple existing requisitions into ONE requisition.
 *
 * IMPORTANT:
 *
 * The original requisitions are NOT deleted.
 *
 * Each copied item keeps:
 *
 * College
 * Faculty
 * Department
 * Quantity
 *
 * through the requesting* fields on ItemSchema.
 */
export async function createConsolidatedRequisition({
  requisitionIds,
  creatorUser,
  purpose,
  urgency,
}) {
  /*
   * --------------------------------------------------
   * VALIDATE INPUT
   * --------------------------------------------------
   */

  if (
    !Array.isArray(requisitionIds) ||
    requisitionIds.length === 0
  ) {
    throw new Error(
      "At least one requisition must be selected."
    );
  }

  /*
   * Prevent duplicate IDs.
   */
  const uniqueIds = [
    ...new Set(
      requisitionIds.map((id) =>
        String(id)
      )
    ),
  ];

  /*
   * --------------------------------------------------
   * LOAD SOURCE REQUISITIONS
   * --------------------------------------------------
   */

  const sourceRequisitions =
    await Requisition.find({
      _id: {
        $in: uniqueIds,
      },
    }).lean();

  if (
    sourceRequisitions.length !==
    uniqueIds.length
  ) {
    throw new Error(
      "One or more selected requisitions could not be found."
    );
  }

  /*
   * --------------------------------------------------
   * VALIDATE SOURCE REQUISITIONS
   * --------------------------------------------------
   *
   * Only submitted/approved requisitions should
   * become part of a consolidated requisition.
   *
   * Drafts must never be consolidated.
   */

  for (const requisition of sourceRequisitions) {
    if (
      requisition.status ===
      REQUISITION_STATUS.DRAFT
    ) {
      throw new Error(
        `Requisition ${
          requisition.requisitionNumber ||
          requisition._id
        } is still a draft and cannot be consolidated.`
      );
    }

    /*
     * Do not allow an already consolidated
     * requisition to be consolidated again.
     */
    if (requisition.isConsolidated) {
      throw new Error(
        `Requisition ${
          requisition.requisitionNumber ||
          requisition._id
        } has already been consolidated.`
      );
    }
  }

  /*
   * --------------------------------------------------
   * BUILD CONSOLIDATED ITEMS
   * --------------------------------------------------
   *
   * Every item receives the organizational
   * information from its original requisition.
   */

  const consolidatedItems = [];

  for (const requisition of sourceRequisitions) {
    for (const item of requisition.items || []) {
      consolidatedItems.push({
        name: item.name,

        requestingCollegeId:
          requisition.collegeId,

        requestingFacultyId:
          requisition.facultyId,

        requestingDepartment:
          requisition.department,

        quantity:
          Number(item.quantity || 0),

        unitCost:
          Number(item.unitCost || 0),

        totalCost:
          Number(item.quantity || 0) *
          Number(item.unitCost || 0),
      });
    }
  }

  if (
    consolidatedItems.length === 0
  ) {
    throw new Error(
      "The selected requisitions contain no items."
    );
  }

  /*
   * --------------------------------------------------
   * CALCULATE TOTAL COST
   * --------------------------------------------------
   */

  const estimatedCost =
    sumEstimatedCost(
      consolidatedItems
    );

  /*
   * --------------------------------------------------
   * BUILD REQUESTING UNITS
   * --------------------------------------------------
   *
   * Remove duplicate organizational units.
   */

  const unitMap = new Map();

  for (const requisition of sourceRequisitions) {
    const key = [
      requisition.collegeId || "",
      requisition.facultyId || "",
      requisition.department || "",
    ].join("|");

    if (!unitMap.has(key)) {
      unitMap.set(key, {
        collegeId:
          requisition.collegeId,

        facultyId:
          requisition.facultyId,

        department:
          requisition.department,
      });
    }
  }

  const requestingUnits = [
    ...unitMap.values(),
  ];

  /*
   * --------------------------------------------------
   * DETERMINE CATEGORY
   * --------------------------------------------------
   *
   * If all source requisitions have the same
   * category, preserve it.
   *
   * Otherwise use "Other".
   */

  const categories = [
    ...new Set(
      sourceRequisitions
        .map(
          (r) => r.category
        )
        .filter(Boolean)
    ),
  ];

  const category =
    categories.length === 1
      ? categories[0]
      : "Other";

  /*
   * --------------------------------------------------
   * DETERMINE URGENCY
   * --------------------------------------------------
   *
   * Use the highest urgency among the source
   * requisitions.
   */

  const urgencyPriority = {
    low: 1,
    normal: 2,
    high: 3,
    urgent: 4,
  };

  const sourceUrgencies =
    sourceRequisitions
      .map(
        (r) => r.urgency
      )
      .filter(Boolean);

  let consolidatedUrgency =
    urgency || "normal";

  if (
    !urgency &&
    sourceUrgencies.length > 0
  ) {
    consolidatedUrgency =
      sourceUrgencies.reduce(
        (highest, current) =>
          (urgencyPriority[current] || 0) >
          (urgencyPriority[highest] || 0)
            ? current
            : highest,
        "low"
      );
  }

  /*
   * --------------------------------------------------
   * PURPOSE
   * --------------------------------------------------
   */

  const consolidatedPurpose =
    purpose ||
    `Consolidated requirements from ${sourceRequisitions.length} requisition(s).`;

  /*
   * --------------------------------------------------
   * ORGANIZATION FOR CONSOLIDATED RECORD
   * --------------------------------------------------
   *
   * There is no single college/faculty/department
   * because multiple units may be represented.
   */

  /*
   * --------------------------------------------------
   * CREATE CONSOLIDATED REQUISITION
   * --------------------------------------------------
   */

  const consolidated =
    await Requisition.create({
      requester:
        creatorUser.id,

      requesterRole:
        creatorUser.role,

      isConsolidated:
        true,

      sourceRequisitions:
        sourceRequisitions.map(
          (r) => r._id
        ),

      consolidatedBy:
        creatorUser.id,

      requestingUnits,

      /*
       * These are intentionally not used for
       * consolidated requisitions.
       */
      collegeId: undefined,
      facultyId: undefined,
      department: undefined,

      category,

      purpose:
        consolidatedPurpose,

      urgency:
        consolidatedUrgency,

      items:
        consolidatedItems,

      estimatedCost,

      status:
        REQUISITION_STATUS.DRAFT,
    });

  /*
   * --------------------------------------------------
   * AUDIT LOG
   * --------------------------------------------------
   */

  await AuditLog.create({
    actor:
      creatorUser.id,

    action:
      "requisition.consolidated_create",

    entityType:
      "Requisition",

    entityId:
      consolidated._id,

    details: {
      sourceRequisitions:
        sourceRequisitions.map(
          (r) => String(r._id)
        ),

      sourceCount:
        sourceRequisitions.length,

      requestingUnits,

      estimatedCost,

      createdByRole:
        creatorUser.role,
    },
  });

  return consolidated;
}

/*
 * --------------------------------------------------
 * MARK SOURCE REQUISITIONS AS CONSOLIDATED
 * --------------------------------------------------
 *
 * We deliberately keep this separate from
 * createConsolidatedRequisition().
 *
 * The UI/API can decide when the source records
 * should become unavailable for another batch.
 */
export async function markRequisitionsAsConsolidated({
  requisitionIds,
  consolidatedRequisitionId,
  actorId,
}) {
  if (
    !Array.isArray(requisitionIds) ||
    requisitionIds.length === 0
  ) {
    return;
  }

  await Requisition.updateMany(
    {
      _id: {
        $in: requisitionIds,
      },
    },
    {
      $set: {
        consolidatedInto:
          consolidatedRequisitionId,
      },
    }
  );

  await AuditLog.create({
    actor: actorId,

    action:
      "requisition.sources_consolidated",

    entityType:
      "Requisition",

    entityId:
      consolidatedRequisitionId,

    details: {
      sourceRequisitions:
        requisitionIds,
    },
  });
    }

export function isRequisitionEscalated(
  estimatedCost
) {
  return isEscalated(
    estimatedCost
  );
  }
