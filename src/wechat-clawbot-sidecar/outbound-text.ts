const WECHAT_DISPLAY_LINE_SEPARATOR = "\u2028";

export function normalizeWechatOutboundText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, WECHAT_DISPLAY_LINE_SEPARATOR);
}
