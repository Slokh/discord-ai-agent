# Discord Rich Components

This document defines the contract for model-selected Discord Components V2 messages, component interactions, and modals. Discord's current inventory and limits are in the official [component reference](https://docs.discord.com/developers/components/reference); acknowledgement and response rules are in [Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding).

## Product Behavior

Discord remains commandless. Members ask naturally; the model may choose a rich presentation when native UI materially improves the answer. Plain text remains the default for simple answers.

Appropriate uses include a few clear next actions, a bounded selection, a multi-field form, a media gallery, a displayed attachment, or a genuinely scannable hierarchy. Decorative buttons, redundant cards, and forms for one easy question are not appropriate. Native Discord polls remain the voting primitive because Components V2 messages cannot contain polls.

The supported surface is exhaustive for the installed Discord API and discord.js version:

- message layout and content: action rows, sections, text displays, thumbnails, media galleries, files, separators, and containers;
- message interactions: buttons plus string, user, role, mentionable, and channel selects;
- modal layout and input: labels, text displays, text inputs, all select types, file uploads, radio groups, checkbox groups, and checkboxes;
- button variants: primary, secondary, success, danger, link, disabled/emoji, and premium at the renderer layer. Premium controls require separately configured app monetization and are not authorization primitives.

## Model And Code Boundary

The model calls `composeDiscordResponse` with a typed semantic presentation. It chooses useful layout, wording, labels, choices, and whether controls belong to the requester or channel. The model never supplies Discord `custom_id` values, runtime IDs, requester authority, permission results, or callback code.

Code validates the complete tree, enforces Discord limits, compiles it through a pure versioned adapter, creates opaque action tokens, stores one pending action generation, activates it against the delivered message, and falls back safely if any phase fails. Generic model-authored controls cannot authorize a mutating tool. Money, wagers, admin changes, deletion, and other mutations still require explicit user-authored current-turn intent or a typed deterministic confirmation owned by the relevant tool.

## Sources Of Truth

- The canonical chat execution remains the `agent_runtime_*` ledger.
- `discord_component_actions` stores only the bounded lifecycle of an interactive control. It is not a second transcript or execution history.
- Each opaque token hash records its action generation and schema version, originating execution, guild, channel, source message, delivered response message, audience/owner, expiry, action payload, and consumption state.
- A versioned `discord_delivery_intent` runtime artifact is the recoverable source of truth between model completion and Discord delivery. It contains the safe response text, footer, semantic presentation, bounded files, reaction, immutable requester, and stable delivery key.
- Conversation memory uses the Discord interaction ID as its unique user-side turn identifier and records the real source message and request kind in metadata.

## Lifecycle

1. The model calls `composeDiscordResponse`; generic structured-argument normalization safely unwraps double-encoded object/array fields, then canonical validation stores the presentation on the single current-turn output collector. Numeric Discord wire types, `custom_id`, and other protocol-owned fields remain invalid.
2. Final synthesis produces normal concise response text.
3. Code stores the complete validated delivery intent before the first Discord write. The pure Discord adapter then compiles response text, presentation, footer, and files and validates the final 40-component payload.
4. Interactive actions are batch-created as one pending generation. Delivery uses stable enforced nonces, sends the payload, then one transaction binds and activates that generation while cancelling the previous generation for the same message.
5. A click or modal submission arrives through `InteractionCreate`. Continuations and submissions are acknowledged before database work; modal-launch IDs identify the synchronous modal path without carrying authority.
6. Code validates guild, channel, response message, requester/audience, expiry, state, and opaque token. Single-use controls are consumed transactionally.
7. A modal-launch action opens its stored modal immediately. A continuation, selection, or modal submission creates a new requester-scoped runtime execution with model-authored action instructions separated from typed current-user submission data.
8. The turn uses the original human source message for Discord context and reply mechanics while keeping the clicking member as the immutable requester.
9. The queued or in-process run updates the component message through the normal response sink and records normal runtime, trace, memory, and delivery state.

## Delivery And Failure Rules

- Components V2 delivery sets `IS_COMPONENTS_V2`; traditional `content` and embeds are cleared. Final text and trace/footer content use text-display components.
- Attached files are exposed with file components. Modal uploads enter the new turn as bounded request attachments.
- Attachment names must be non-empty and unique, and Discord's ten-attachment message limit is enforced before any write.
- A Components V2 message allows at most 40 total components. Structural and field limits are validated before delivery.
- Once a message uses Components V2, all later status and final edits remain Components V2; plain follow-ups are rendered as Text Display components because Discord does not allow removing the flag.
- Compilation or persistence failure falls back before delivery. Delivery or activation failure cancels the pending generation, replaces interactive controls with a non-interactive Components V2 fallback when necessary, and records `discord.presentation.fallback`.
- A failed composition attempt cannot be presented as success: if no validated presentation was registered, a deterministic outcome guard replaces any model-authored success claim with an honest retry message and records `agent.rich_presentation_guard.blocked`.
- Successful rich delivery records `discord.presentation.delivered`; accepted clicks/submissions record `discord.component.accepted`.
- Startup recovery replays the complete delivery intent, creates fresh opaque action tokens, reconciles the execution and conversation ledger, and uses the same stable enforced message nonces so a retry returns the recent matching message instead of creating a duplicate.
- Opaque action tokens contain no secrets or authoritative action arguments. Only their hashes are stored.
- Replacing a component message atomically cancels its previous active generation, so stale client controls fail closed. Expired actions fail closed and an hourly bounded sweep removes them from active indexes. Deleting the originating runtime execution cascades its actions.

## Ownership

- Semantic types and validation: `src/discord/components/types.ts`, `validation.ts`; TypeScript types and the model JSON schema are both derived from the canonical Zod schema.
- Discord API compilation and custom-ID parsing: `src/discord/components/renderer.ts`.
- Component and modal ingress: `src/discord/components/interactionHandler.ts`, `interactionNormalization.ts`, and `interactionResponder.ts`.
- Durable actions: `src/db/discordComponentActionRepository.ts` and migrations `019_discord_component_actions.sql`, `020_discord_component_action_generations.sql`, and `021_discord_component_action_expiry_index.sql`.
- Model tool and guidance: `src/tools/discordPresentationTools.ts`, `src/tools/registry.ts`, and `src/agent/promptBuilder.ts`.
- Final delivery, action activation, recovery, and fallback: `src/discord/responseSink.ts`, `src/discord/presentationDelivery.ts`, `src/discord/deliveryIntent.ts`, `src/discord/deliverySweep.ts`, and `src/discord/agentDelivery.ts`.

## Verification

Focused coverage includes every component family, protocol cross-field constraints, missing attachment references, final nesting and limits, custom-ID action classes, requester/channel scope, generation replacement, expiry and single-use races, modal fields and files, runtime-envelope request/source separation, Components V2 follow-up/status edits, rich delivery and fallback, and the generic mutation guard. Database changes require `npm run verify:db`; TypeScript changes require `npm run typecheck`; broad handoff requires `npm run verify`.
