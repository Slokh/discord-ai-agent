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

Code validates the complete tree, enforces Discord limits, compiles it to Components V2, creates opaque action tokens, stores action state, binds actions to the delivered message, and falls back to plain text if Discord rejects rich delivery. Generic model-authored controls cannot authorize a mutating tool. Money, wagers, admin changes, deletion, and other mutations still require explicit user-authored current-turn intent or a typed deterministic confirmation owned by the relevant tool.

## Sources Of Truth

- The canonical chat execution remains the `agent_runtime_*` ledger.
- `discord_component_actions` stores only the bounded lifecycle of an interactive control. It is not a second transcript or execution history.
- Each opaque token hash records its originating execution, guild, channel, source message, delivered response message, audience/owner, expiry, action payload, and consumption state.
- Conversation memory uses the Discord interaction ID as its unique user-side turn identifier and records the real source message and request kind in metadata.

## Lifecycle

1. The model calls `composeDiscordResponse`; validation stores the presentation on the current tool context.
2. Final synthesis produces normal concise response text.
3. Delivery compiles the response text, presentation, footer, and files into one Components V2 payload.
4. Interactive actions are persisted before delivery and bound to the actual bot response ID after delivery succeeds.
5. A click or modal submission arrives through `InteractionCreate` and is acknowledged within Discord's three-second deadline.
6. Code validates guild, channel, response message, requester/audience, expiry, state, and opaque token. Single-use controls are consumed transactionally.
7. A modal-launch action opens its stored modal immediately. A continuation, selection, or modal submission creates a new requester-scoped runtime execution.
8. The turn uses the original human source message for Discord context and reply mechanics while keeping the clicking member as the immutable requester.
9. The queued or in-process run updates the component message through the normal response sink and records normal runtime, trace, memory, and delivery state.

## Delivery And Failure Rules

- Components V2 delivery sets `IS_COMPONENTS_V2`; traditional `content` and embeds are cleared. Final text and trace/footer content use text-display components.
- Attached files are exposed with file components. Modal uploads enter the new turn as bounded request attachments.
- A Components V2 message allows at most 40 total components. Structural and field limits are validated before delivery.
- Compilation or rich-delivery failure falls back to the normal plain-text/file response and records `discord.presentation.fallback`.
- Successful rich delivery records `discord.presentation.delivered`; accepted clicks/submissions record `discord.component.accepted`.
- Opaque action tokens contain no secrets or authoritative action arguments. Only their hashes are stored.
- Expired actions fail closed and are marked expired opportunistically. Deleting the originating runtime execution cascades its actions.

## Ownership

- Semantic types and validation: `src/discord/components/types.ts`, `validation.ts`.
- Discord API compilation and custom-ID parsing: `src/discord/components/renderer.ts`.
- Component and modal ingress: `src/discord/components/interactionHandler.ts`.
- Durable actions: `src/db/discordComponentActionRepository.ts` and migration `019_discord_component_actions.sql`.
- Model tool and guidance: `src/tools/discordPresentationTools.ts`, `src/tools/registry.ts`, and `src/agent/promptBuilder.ts`.
- Final delivery and fallback: `src/discord/responseSink.ts` and `src/discord/agentDelivery.ts`.

## Verification

Focused coverage includes every component family, invalid nesting and limits, custom-ID parsing, requester/channel scope, expiry and single-use races, modal fields and files, runtime-envelope request/source separation, rich delivery and fallback, and the generic mutation guard. Database changes require `npm run verify:db`; TypeScript changes require `npm run typecheck`; broad handoff requires `npm run verify`.
