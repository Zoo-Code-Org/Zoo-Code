---- MODULE SonnetCapabilitiesMC ----
\* Model-checking selectors and injected defects for SonnetCapabilities.
\* Contract, findings, and cost: see the SonnetCapabilities header. Fixed passes and eight defect variants fail.
EXTENDS SonnetCapabilities
CONSTANT Variant

OffBug == (Variant = "OmitOff" /\ input.provider \in {"anthropic", "vertex"})
          \/ (Variant = "RequestyOff" /\ input.provider = "requesty")
          \/ (Variant = "BedrockOff" /\ input.provider = "bedrock")
MCThinking == IF input.enabled THEN "adaptive"
            ELSE IF OffBug THEN "omitted" ELSE "between_tools"

MCOverrideId == IF (Variant = "OpenRouterId" /\ input.provider = "openrouter")
                \/ (Variant = "VercelId" /\ input.provider = "vercel")
              THEN "anthropic/claude-sonnet-5-5" ELSE CatalogId
MCBudget == IF Variant = "RequestyBudget" THEN input.reportedBudget
            ELSE IF input.listed THEN TRUE ELSE input.reportedBudget

MergedMember == IF Variant = "LostMember" THEN FALSE
                ELSE IF Variant = "BroadMatch" THEN TRUE ELSE input.listed
MCMergedEffects == IF MergedMember THEN MemberEffects ELSE {}
====
