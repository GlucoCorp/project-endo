# Staff provisioning (clinicians and organisation admins)

REQ-010, spec 10.2, Section 24 item 39, RISK-S06. Owner: support, with the organisation's admin.

Clinicians sign in with passkeys (phishing-resistant). An organisation admin invites colleagues from the clinic desk (**Organisation settings and team → Invite a colleague**); the invitation is claimed when the colleague signs in with their own staff account. Until self-service staff enrolment exists, the staff account itself is created by support.

## First admin of a new organisation

1. The customer's signed order names the first admin (by role and work email). Verify it with the customer's contact on a known phone number.
2. Create the organisation row (region, name) with the provisioning script run by support under just-in-time access.
3. Create the staff account (below), then the first `clinician` row with role `org_admin` for that person.
4. From then on, the organisation's admin invites and manages its own team.

## Staff account for an invited colleague

1. The colleague's admin confirms the request (who, which organisation, which role) in the support ticket.
2. Create the Keycloak user (username = work email, no password), with the required action "register a passkey"; send the setup link to the work email only.
3. Create the identity person for that Keycloak subject (support tool, identity scope `identity.person.create`), with display name and work email (encrypted under the person's key).
4. Tell the admin the account is ready; the admin sends the invitation link (single use, at most 7 days); the colleague signs in and the invitation is claimed.

## Leaving

- The organisation admin deactivates the member in **Team** (takes effect on the next request).
- Support disables the Keycloak user if the person leaves every organisation.

## Review

Weekly: support reviews accounts created and invitations claimed (counts and organisations).
