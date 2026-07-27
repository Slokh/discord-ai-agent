export function resolveContextImageSelection(input: {
  requestText?: string;
  requested?: boolean;
  contextHasImages: boolean;
}) {
  if (input.requested !== false) {
    return {
      useContextImages: true,
      overrodeModelOptOut: false,
    };
  }
  const userExplicitlyOptedOut = IMAGE_CONTEXT_OPT_OUT.test(
    input.requestText?.trim() ?? "",
  );
  return {
    useContextImages: input.contextHasImages && !userExplicitlyOptedOut,
    overrodeModelOptOut: input.contextHasImages && !userExplicitlyOptedOut,
  };
}

const IMAGE_CONTEXT_OPT_OUT =
  /\b(?:without|do not use|don't use|ignore|exclude|leave out)\b.{0,80}\b(?:the\s+)?(?:current|attached|replied|previous|prior|reference|source|context)?\s*(?:image|images|picture|pictures|photo|photos|attachment|attachments)\b|\bfrom scratch\b/i;
