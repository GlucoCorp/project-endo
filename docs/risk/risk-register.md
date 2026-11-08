# Risk register

ISO 14971 structure (spec 18.4). IDs are stable. Security risks are detailed in `docs/threat-model.md`; this register adds severity, probability and the residual-risk decision, which require the clinical lead and the security lead.

| ID       | Hazard / threat                     | Severity      | Probability   | Controls     | Residual risk | Owner            |
| -------- | ----------------------------------- | ------------- | ------------- | ------------ | ------------- | ---------------- |
| RISK-S01 | Stolen clinician credentials        | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-S02 | Shared-phone exposure               | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-S03 | Forged or replayed service token    | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-T01 | Altered rule set                    | TODO          | TODO          | threat model | TODO          | Clinical lead    |
| RISK-T02 | Malicious dependency                | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-T03 | Ciphertext swapped between records  | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-T04 | Unreviewed code reaches main        | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-R01 | Disputed clinical decision          | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-I01 | Clinical DB exfiltration            | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-I02 | PHI in logs or errors               | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-I03 | Cross-organisation leak             | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-I04 | Legal demand for reproductive data  | TODO          | TODO          | threat model | TODO          | DPO              |
| RISK-I05 | Service token reaches browser       | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-D01 | Request flooding                    | TODO          | TODO          | threat model | TODO          | Platform lead    |
| RISK-D02 | Ransomware                          | TODO          | TODO          | threat model | TODO          | Platform lead    |
| RISK-E01 | Support staff access PHI            | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-E02 | Compromised integration             | TODO          | TODO          | threat model | TODO          | Integration lead |
| RISK-E03 | Route ships without authorisation   | TODO          | TODO          | threat model | TODO          | Security lead    |
| RISK-E04 | Dev stand-ins reach production      | TODO          | TODO          | threat model | TODO          | Platform lead    |
| RISK-C01 | False "working" verdict delays care | TODO_CLINICAL | TODO_CLINICAL | threat model | TODO_CLINICAL | Clinical lead    |
| RISK-C02 | Red flag missed                     | TODO_CLINICAL | TODO_CLINICAL | threat model | TODO_CLINICAL | Clinical lead    |

Severity and probability scales are set by the clinical and security leads; engineers do not assign them.
