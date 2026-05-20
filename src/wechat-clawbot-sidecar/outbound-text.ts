export function normalizeWechatOutboundText(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}
