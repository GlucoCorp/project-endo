# Access requests (just-in-time)

Spec 10.3, 12.6. GluCorp staff have no standing access to production data.

1. Request elevation in the approval workflow: what, why (ticket or incident), which environment, how long (at most 4 hours).
2. A second person approves (never the requester). Hardware security key required for the session.
3. The session is recorded; actions inside the clinical and identity databases go through audited roles (`support.phi_access` in the API is purpose-bound and audited per access).
4. Access expires automatically; ask again if more time is needed.
5. Weekly review: the security lead reviews every elevation, rotation and Keycloak deletion recorded that week.

Patients' own requests about their data (access, correction, deletion) go to the DPO contact route in the app; deletion and export are self-service (REQ-009).
