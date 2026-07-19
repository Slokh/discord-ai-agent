import { MessageFlags, type MessageComponentInteraction, type ModalBuilder, type ModalSubmitInteraction } from "discord.js";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../../util/logger.js";
import { discordWrite } from "../api.js";

type RichInteraction = MessageComponentInteraction | ModalSubmitInteraction;

export class DiscordInteractionResponder {
  constructor(private readonly interaction: RichInteraction, private readonly logger: Logger = defaultLogger) {}

  async acknowledgeUpdate(): Promise<void> {
    if (this.interaction.deferred || this.interaction.replied) return;
    await this.write("defer_interaction_update", () => this.interaction.deferUpdate());
  }

  async showModal(modal: ModalBuilder): Promise<void> {
    if (!this.interaction.isMessageComponent()) throw new Error("Only a message component can open a Discord modal.");
    if (this.interaction.deferred || this.interaction.replied) throw new Error("Discord modal launch must be the initial interaction response.");
    const interaction = this.interaction;
    await this.write("show_interaction_modal", () => interaction.showModal(modal));
  }

  async ephemeral(content: string): Promise<void> {
    const payload = { content, flags: MessageFlags.Ephemeral } as const;
    if (this.interaction.deferred || this.interaction.replied) {
      await this.write("follow_up_interaction", () => this.interaction.followUp(payload), false);
    } else {
      await this.write("reply_to_interaction", () => this.interaction.reply(payload), false);
    }
  }

  private async write(action: string, operation: () => Promise<unknown>, required = true): Promise<void> {
    const result = await discordWrite(operation, {
      logger: this.logger,
      retries: 0,
      throwUnknown: false,
    }, action);
    if (!result.ok) {
      this.logger.warn({ action, reason: result.reason, interactionId: this.interaction.id }, "Discord interaction response was not delivered");
      if (required) throw result.error;
    }
  }
}
