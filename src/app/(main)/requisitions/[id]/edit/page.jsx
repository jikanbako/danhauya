"use client";

import { useEffect, useState } from "react";
import {
  useParams,
  useRouter,
} from "next/navigation";

import axios from "axios";
import toast from "react-hot-toast";

import Button from "@/components/ui/Button";

import RequisitionWizardStep1 from "@/components/requisitions/RequisitionWizardStep1";
import RequisitionWizardStep2 from "@/components/requisitions/RequisitionWizardStep2";
import RequisitionWizardStep3 from "@/components/requisitions/RequisitionWizardStep3";

import { ROLES } from "@/constants/roles";

import wizardStyles from "./page.module.css";

const STEPS = [
  "Details",
  "Items",
  "Review & Submit",
];

export default function EditRequisitionPage() {
  const { id } = useParams();

  const router = useRouter();

  const [data, setData] =
    useState(null);

  const [user, setUser] =
    useState(null);

  const [step, setStep] =
    useState(0);

  const [saving, setSaving] =
    useState(false);

  const [submitting, setSubmitting] =
    useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [
          requisitionResponse,
          userResponse,
        ] = await Promise.all([
          axios.get(
            `/api/requisitions/${id}`
          ),

          axios.get(
            "/api/users/me"
          ),
        ]);

        setData(
          requisitionResponse.data
            .requisition
        );

        setUser(
          userResponse.data.user
        );
      } catch (error) {
        toast.error(
          error.response?.data?.message ||
            "Failed to load requisition."
        );
      }
    }

    load();
  }, [id]);

  function update(partial) {
    setData((current) => ({
      ...current,
      ...partial,
    }));
  }

  async function saveDraft({
    silent = false,
  } = {}) {
    setSaving(true);

    try {
      const payload = {
        category:
          data.category,

        purpose:
          data.purpose,

        urgency:
          data.urgency,

        items:
          data.items,

        /*
         * Important for Procurement/Dean/Provost
         * when editing/resuming.
         */
        requestingUnits:
          data.requestingUnits,
      };

      const {
        data: response,
      } = await axios.patch(
        `/api/requisitions/${id}`,
        payload
      );

      if (!silent) {
        toast.success(
          "Changes saved."
        );
      }

      setData(
        response.requisition
      );

      return response.requisition;
    } catch (error) {
      toast.error(
        error.response?.data?.message ||
          "Failed to save."
      );

      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleNext() {
    const saved =
      await saveDraft({
        silent: true,
      });

    if (!saved) return;

    setStep((current) =>
      Math.min(
        current + 1,
        STEPS.length - 1
      )
    );
  }

  function handleBack() {
    setStep((current) =>
      Math.max(current - 1, 0)
    );
  }

  async function handleSubmit() {
    if (
      user?.role === ROLES.PROCUREMENT ||
      user?.role === ROLES.DEAN ||
      user?.role === ROLES.PROVOST
    ) {
      if (
        !data.requestingUnits ||
        data.requestingUnits.length === 0
      ) {
        toast.error(
          "Please select at least one requesting College, Faculty and Department."
        );

        setStep(0);

        return;
      }

      if (data.requestingUnits.length > 1) {
        const untaggedItem = (
          data.items || []
        ).find(
          (item) =>
            !item.requestingDepartment
        );

        if (untaggedItem) {
          toast.error(
            "Please tag every item with which department it's for."
          );

          setStep(1);

          return;
        }
      }
    }

    const saved =
      await saveDraft({
        silent: true,
      });

    if (!saved) return;

    setSubmitting(true);

    try {
      await axios.post(
        `/api/requisitions/${id}/submit`
      );

      toast.success(
        "Requisition submitted for approval."
      );

      router.push(
        `/requisitions/${id}`
      );
    } catch (error) {
      toast.error(
        error.response?.data?.message ||
          "Submission failed."
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!data || !user) {
    return <p>Loading…</p>;
  }

  const requesterRole =
    data.requesterRole ||
    user.role;

  return (
    <div
      className={
        wizardStyles.wrapper
      }
    >
      <h1
        className={
          wizardStyles.heading
        }
      >
        {data.status ===
        "returned"
          ? "Amend & Resubmit Requisition"
          : "Resume Draft"}
      </h1>

      <div
        className={
          wizardStyles.steps
        }
      >
        {STEPS.map(
          (label, index) => (
            <div
              key={label}
              className={`${wizardStyles.stepIndicator} ${
                index === step
                  ? wizardStyles.stepActive
                  : ""
              } ${
                index < step
                  ? wizardStyles.stepDone
                  : ""
              }`}
            >
              <span
                className={
                  wizardStyles.stepNumber
                }
              >
                {index + 1}
              </span>

              <span
                className={
                  wizardStyles.stepLabel
                }
              >
                {label}
              </span>
            </div>
          )
        )}
      </div>

      <div
        className={
          wizardStyles.stepBody
        }
      >
        {step === 0 && (
          <RequisitionWizardStep1
            data={data}
            onChange={update}
            requesterRole={
              requesterRole
            }
            requesterCollegeId={
              user.collegeId
            }
            requesterFacultyId={
              user.facultyId
            }
          />
        )}

        {step === 1 && (
          <RequisitionWizardStep2
            items={
              data.items || []
            }
            requestingUnits={
              data.requestingUnits
            }
            onChange={update}
          />
        )}

        {step === 2 && (
          <RequisitionWizardStep3
            data={data}
            requisitionId={id}
            onAttachmentsUploaded={(
              attachments
            ) =>
              update({
                attachments,
              })
            }
          />
        )}
      </div>

      <div
        className={
          wizardStyles.actions
        }
      >
        <div
          className={
            wizardStyles.actionsLeft
          }
        >
          {step > 0 && (
            <Button
              variant="ghost"
              onClick={handleBack}
            >
              Back
            </Button>
          )}
        </div>

        <div
          className={
            wizardStyles.actionsRight
          }
        >
          <Button
            variant="secondary"
            onClick={() =>
              saveDraft()
            }
            loading={saving}
          >
            Save Changes
          </Button>

          {step <
          STEPS.length - 1 ? (
            <Button
              onClick={handleNext}
              loading={saving}
            >
              Next
            </Button>
          ) : (
            <Button
              onClick={
                handleSubmit
              }
              loading={
                submitting
              }
            >
              Submit for Approval
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
