# Incident response

Spec 12.10. Applies to every environment that holds real data. Roles are named by function; the on-call rota names the people.

## Severity

| Level | Meaning                                                         | Examples                                                                                                          | Response                                                                        |
| ----- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SEV-1 | Personal data exposed or at risk, or patient safety affected    | PHI in a log or URL in production; a red flag not shown; clinical data reachable across organisations; ransomware | Page now; incident lead within 15 minutes; regulatory clock starts at awareness |
| SEV-2 | Security control failed without known exposure, or service down | Audit writes failing (requests fail closed); a dependency CVE exploitable in our setup; sign-in down              | Within 1 hour                                                                   |
| SEV-3 | Degraded or contained                                           | Reminders delayed; one integration failing closed                                                                 | Next working day                                                                |

When in doubt, start at SEV-1 and step down.

## Roles

- **Incident lead:** runs the response, keeps the timeline, decides severity.
- **Security lead:** forensics, containment, evidence; decides on notification with the DPO.
- **DPO:** regulatory notifications and the decision whether affected people are told.
- **Clinical lead:** any patient-safety angle (red flags, verdicts, decisions).
- **Communications:** customer (clinic) and patient messages from the templates below.

## First hour

1. Open the incident channel and the timeline document (UTC times). Record when the organisation became aware: the notification clocks start then.
2. Contain: revoke the affected credentials (`key-rotation.md`), disable the affected route or integration (integrations fail closed), scale down if needed. Do not delete evidence.
3. Preserve: snapshot affected databases and logs to the restricted evidence bucket.
4. Decide severity and who else is needed.

## Regulatory clocks (from awareness)

| Regime                         | Deadline                                                                                                        | Who             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------- |
| GDPR (EU/UK)                   | Supervisory authority within **72 hours** if there is a risk to people; people without undue delay if high risk | DPO             |
| Kenya Data Protection Act 2019 | Data Commissioner within **72 hours**; people without undue delay where there is a real risk of harm            | DPO             |
| HIPAA (US)                     | Individuals without unreasonable delay and within **60 days**; HHS (and media for 500+ in a state) per the rule | Privacy officer |
| Other regions                  | `TODO_LEGAL` per region before launch there                                                                     | DPO             |
| Customers (clinics)            | Per the data processing agreement (`TODO_LEGAL`: typically 24 to 48 hours)                                      | Communications  |

If facts are incomplete at the deadline, notify with what is known and follow up.

## Templates

**To a clinic (processor to controller):** what happened, when we became aware, which of their data and how many people may be affected (counts, no names), what we have done, what we need from them, next update time.

**To affected patients (when the DPO decides):** plain words, no jargon; what happened; what it means for them; what we did; what they can do; who to contact. Reviewed by the clinical lead when health data is involved. Never in a push notification (spec 15: notifications carry no health content).

## After

- Post-incident review within 5 working days, blameless, with actions tracked to closure.
- Update the threat model (`docs/threat-model.md`) and this runbook.
- Tabletop exercises twice a year, including a ransomware scenario and a compromised-integration scenario.
