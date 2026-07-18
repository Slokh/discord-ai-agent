import { MessageFlags, type MessageComponentInteraction, type ModalBuilder, type ModalSubmitInteraction } from "discord.js";

type RichInteraction = MessageComponentInteraction | ModalSubmitInteraction;

export class DiscordInteractionResponder {
  constructor(private readonly interaction: RichInteraction) {}

  async acknowledgeUpdate(): Promise<void> {
    if (this.interaction.deferred || this.interaction.replied) return;
    await this.interaction.deferUpdate();
  }

  async showModal(modal: ModalBuilder): Promise<void> {
    if (!this.interaction.isMessageComponent()) throw new Error("Only a message component can open a Discord modal.");
    if (this.interaction.deferred || this.interaction.replied) throw new Error("Discord modal launch must be the initial interaction response.");
    await this.interaction.showModal(modal);
  }

  async ephemeral(content: string): Promise<void> {
    const payload = { content, flags: MessageFlags.Ephemeral } as const;
    if (this.interaction.deferred || this.interaction.replied) {
      await this.interaction.followUp(payload).catch(() => undefined);
    } else {
      await this.interaction.reply(payload).catch(() => undefined);
    }
  }
}
