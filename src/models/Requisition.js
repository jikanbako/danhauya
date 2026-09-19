import mongoose from "mongoose";
import { REQUISITION_STATUS } from "@/constants/requisitionOptions";

/*
 * --------------------------------------------------
 * ITEM SCHEMA
 * --------------------------------------------------
 *
 * For a normal requisition:
 *   requestingCollegeId
 *   requestingFacultyId
 *   requestingDepartment
 * can remain empty.
 *
 * For a consolidated requisition:
 * each item identifies exactly which
 * organizational unit requested it.
 */
const ItemSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    requestingCollegeId: {
      type: String,
    },

    requestingFacultyId: {
      type: String,
    },

    requestingDepartment: {
      type: String,
    },

    /*
     * Only set on items belonging to a consolidated
     * requisition — identifies exactly which source
     * requisition this item came from, so one source can
     * be detached (dropped from the consolidation) without
     * ambiguity even when two sources share the same
     * department.
     */
    sourceRequisitionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Requisition",
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    unitCost: {
      type: Number,
      required: true,
      min: 0,
    },

    /*
     * Procurement keeps the original requester price separate
     * from the market-survey price. `unitCost` remains the
     * effective/current unit cost used by totals and documents.
     */
    requestedUnitCost: {
      type: Number,
      min: 0,
    },

    requestedTotalCost: {
      type: Number,
      min: 0,
    },

    procurementUnitCost: {
      type: Number,
      min: 0,
    },

    procurementNote: {
      type: String,
      trim: true,
    },

    totalCost: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

/*
 * --------------------------------------------------
 * ATTACHMENT SCHEMA
 * --------------------------------------------------
 */
const ProcurementAssignmentHistorySchema = new mongoose.Schema(
  {
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    note: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const ProcurementPriceHistorySchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true },
    itemName: { type: String, required: true },
    itemIndex: { type: Number, required: true },
    requestedUnitCost: { type: Number, min: 0 },
    previousProcurementUnitCost: { type: Number, min: 0 },
    procurementUnitCost: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AttachmentSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
    },

    publicId: {
      type: String,
      required: true,
    },

    fileName: {
      type: String,
      required: true,
    },

    fileType: {
      type: String,
      required: true,
    },

    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

/*
 * --------------------------------------------------
 * COMMENT SCHEMA
 * --------------------------------------------------
 */
const CommentSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    message: {
      type: String,
      required: true,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

/*
 * --------------------------------------------------
 * APPROVAL CHAIN STEP
 * --------------------------------------------------
 *
 * type = "approval"
 *   The person must approve, return or reject.
 *
 * type = "processing"
 *   Informational processing stage.
 *   Procurement does NOT approve the requisition.
 */
const ApprovalChainStepSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
    },

    approver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    type: {
      type: String,
      enum: ["approval", "procurement_review", "processing"],
      default: "approval",
    },
  },
  { _id: false }
);

/*
 * --------------------------------------------------
 * REQUISITION SCHEMA
 * --------------------------------------------------
 */
const RequisitionSchema = new mongoose.Schema(
  {
    /*
     * --------------------------------------------------
     * BASIC IDENTIFICATION
     * --------------------------------------------------
     */
    requisitionNumber: {
      type: String,
      unique: true,
      sparse: true,
    },

    /*
     * User who initiated the requisition.
     */
    requester: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    /*
     * Role of the user who created the requisition.
     */
    requesterRole: {
      type: String,
      required: true,
    },

    /*
 * --------------------------------------------------
 * CONSOLIDATED REQUISITION
 * --------------------------------------------------
 */

isConsolidated: {
  type: Boolean,
  default: false,
},

sourceRequisitions: [
  {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Requisition",
  },
],

consolidatedBy: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "User",
},

consolidatedInto: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Requisition",
},

consolidatedAt: {
  type: Date,
},

requestingUnits: [
  {
    collegeId: {
      type: String,
      required: true,
    },

    facultyId: {
      type: String,
    },

    department: {
      type: String,
    },
  },
],

    /*
     * --------------------------------------------------
     * ORGANIZATIONAL SNAPSHOT
     * --------------------------------------------------
     *
     * Normal requisition:
     *
     * College → Faculty → Department
     *
     * Consolidated requisition:
     * these fields are not required because
     * multiple organizational units may be involved.
     */
    collegeId: {
      type: String,
      required: function () {
        return !this.isConsolidated;
      },
    },

    facultyId: {
      type: String,
      required: function () {
        return !this.isConsolidated;
      },
    },

    department: {
      type: String,
      required: function () {
        return !this.isConsolidated;
      },
    },

    /*
     * --------------------------------------------------
     * REQUISITION DETAILS
     * --------------------------------------------------
     */
    category: {
      type: String,
    },

    purpose: {
      type: String,
    },

    urgency: {
      type: String,
    },

    /*
     * --------------------------------------------------
     * ITEMS
     * --------------------------------------------------
     *
     * For consolidated requisitions, each item can
     * identify its requesting department.
     */
    items: {
      type: [ItemSchema],
      default: [],
    },

    estimatedCost: {
      type: Number,
      default: 0,
    },

    /*
     * --------------------------------------------------
     * ATTACHMENTS & COMMENTS
     * --------------------------------------------------
     */
    attachments: {
      type: [AttachmentSchema],
      default: [],
    },

    comments: {
      type: [CommentSchema],
      default: [],
    },

    /*
     * --------------------------------------------------
     * MAIN REQUISITION STATUS
     * --------------------------------------------------
     *
     * draft
     * pending
     * returned
     * approved
     * rejected
     */
    status: {
      type: String,
      enum: Object.values(REQUISITION_STATUS),
      default: REQUISITION_STATUS.DRAFT,
    },

    /*
     * --------------------------------------------------
     * APPROVAL CHAIN
     * --------------------------------------------------
     *
     * Normal example:
     *
     * HOD → Dean → Provost → VC → Procurement
     *
     * Procurement is "processing", not "approval".
     */
    approvalChain: {
      type: [ApprovalChainStepSchema],
      default: [],
    },

    /*
     * --------------------------------------------------
     * CURRENT STEP
     * --------------------------------------------------
     *
     * Identifies the current stage of the workflow.
     *
     * After VC approval this points to Procurement.
     */
    currentStepIndex: {
      type: Number,
      default: 0,
    },

    /*
     * --------------------------------------------------
     * REQUESTER ACTION
     * --------------------------------------------------
     *
     * true when the requisition has been returned
     * and the requester must edit/resubmit it.
     */
    awaitingRequesterAction: {
      type: Boolean,
      default: false,
    },

    /*
     * --------------------------------------------------
     * ESCALATION
     * --------------------------------------------------
     */
    requiresGovernorApproval: {
      type: Boolean,
      default: false,
    },

    /*
     * --------------------------------------------------
     * FINAL APPROVAL
     * --------------------------------------------------
     *
     * Set when VC gives final approval.
     */
    finalApprovalAt: {
      type: Date,
    },

    /*
     * --------------------------------------------------
     * PROCUREMENT PROCESSING
     * --------------------------------------------------
     *
     * Procurement does NOT approve the requisition.
     *
     * After VC approval:
     *
     * ready
     *   ↓
     * processing
     *   ↓
     * completed
     */
    procurementStatus: {
      type: String,
      enum: [
        "review",
        "submitted_to_vc",
        "ready",
        "processing",
        "completed",
      ],
      default: undefined,
    },

    /* Procurement market-survey / BOQ stage metadata. */
    procurementReviewStartedAt: {
      type: Date,
    },

    submittedToVcAt: {
      type: Date,
    },

    boqGeneratedAt: {
      type: Date,
    },

    procurementRevision: {
      type: Number,
      default: 0,
    },

    procurementNotes: {
      type: String,
      trim: true,
    },

    procurementPriceHistory: {
      type: [ProcurementPriceHistorySchema],
      default: [],
    },

    /*
     * Procurement staff member assigned to
     * process the requisition.
     */
    procurementOfficer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    /*
     * Staff member currently responsible for the Procurement Review /
     * market-survey work. Kept separate from the Director who receives
     * the requisition first.
     */
    procurementAssignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    procurementAssignedAt: {
      type: Date,
    },

    procurementAssignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    procurementAssignmentHistory: {
      type: [ProcurementAssignmentHistorySchema],
      default: [],
    },

    /*
     * When Procurement received the requisition.
     */
    procurementReceivedAt: {
      type: Date,
    },

    /*
     * When Procurement started processing.
     */
    procurementStartedAt: {
      type: Date,
    },

    /*
     * When Procurement completed processing.
     */
    procurementCompletedAt: {
      type: Date,
    },

    /*
     * --------------------------------------------------
     * TIMESTAMPS
     * --------------------------------------------------
     */
    submittedAt: {
      type: Date,
    },

    decidedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

/*
 * --------------------------------------------------
 * MODEL EXPORT
 * --------------------------------------------------
 *
 * Prevents OverwriteModelError during Next.js
 * development hot reloads.
 */
export default mongoose.models.Requisition ||
  mongoose.model(
    "Requisition",
    RequisitionSchema
  );
