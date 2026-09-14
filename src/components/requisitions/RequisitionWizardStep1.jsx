"use client";

import SelectField from "@/components/forms/SelectField";
import RequestingOrganizationSelect from "@/components/requisitions/RequestingOrganizationSelect";

import styles from "./RequisitionWizardStep1.module.css";

import {
  REQUISITION_CATEGORIES,
  URGENCY_LEVELS,
} from "@/constants/requisitionOptions";

import { ROLES } from "@/constants/roles";

export default function RequisitionWizardStep1({
  data,
  onChange,
  requesterRole,
  requesterCollegeId,
  requesterFacultyId,
}) {
  const isConsolidated =
    data?.isConsolidated === true ||
    (Array.isArray(data?.sourceRequisitions) &&
      data.sourceRequisitions.length > 0);

  const showRequestingOrganization =
    !isConsolidated &&
    (requesterRole === ROLES.PROCUREMENT ||
      requesterRole === ROLES.DEAN ||
      requesterRole === ROLES.PROVOST);

  return (
    <div className={styles.wrapper}>
      {/* ------------------------------------------------
          REQUESTING ORGANIZATION
          (Procurement: fully open. Dean/Provost: locked
          to their own college/faculty, see component.)
      ------------------------------------------------ */}

      {showRequestingOrganization && (
        <RequestingOrganizationSelect
          value={
            data.requestingUnits || []
          }
          onChange={onChange}
          requesterRole={requesterRole}
          homeCollegeId={requesterCollegeId}
          homeFacultyId={requesterFacultyId}
        />
      )}

      {/* ------------------------------------------------
          CATEGORY
      ------------------------------------------------ */}

      <SelectField
        id="category"
        label="Category"
        required
        value={
          data.category || ""
        }
        onChange={(e) =>
          onChange({
            category:
              e.target.value,
          })
        }
      >
        <option value="">
          Select category
        </option>

        {REQUISITION_CATEGORIES.map(
          (category) => (
            <option
              key={category}
              value={category}
            >
              {category}
            </option>
          )
        )}
      </SelectField>

      {/* ------------------------------------------------
          URGENCY
      ------------------------------------------------ */}

      <SelectField
        id="urgency"
        label="Urgency"
        required
        value={
          data.urgency || ""
        }
        onChange={(e) =>
          onChange({
            urgency:
              e.target.value,
          })
        }
      >
        <option value="">
          Select urgency
        </option>

        {URGENCY_LEVELS.map(
          (urgency) => (
            <option
              key={urgency.value}
              value={urgency.value}
            >
              {urgency.label}
            </option>
          )
        )}
      </SelectField>

      {/* ------------------------------------------------
          PURPOSE
      ------------------------------------------------ */}

      <div className={styles.field}>
        <label
          htmlFor="purpose"
          className={styles.label}
        >
          Purpose / Justification
        </label>

        <textarea
          id="purpose"
          className={styles.textarea}
          rows={4}
          required
          value={
            data.purpose || ""
          }
          onChange={(e) =>
            onChange({
              purpose:
                e.target.value,
            })
          }
          placeholder="Explain why this requisition is needed…"
        />
      </div>
    </div>
  );
              }
