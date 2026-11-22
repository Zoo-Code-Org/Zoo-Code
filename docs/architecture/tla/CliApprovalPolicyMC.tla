---- MODULE CliApprovalPolicyMC ----
\* Model-checking settings for CliApprovalPolicy.
EXTENDS CliApprovalPolicy

\* Sabotage: the clamp is removed. Use it as the replacement for Sent.
SentNoClamp(in) == in

====
