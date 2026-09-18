/** Office formats supported by the read-only PDF preview, shared by UI and server. */
export function isOfficeFile(filename: string): boolean {
  return /\.(pptx?|docx?|xlsx?|odp|odt|ods)$/i.test(filename);
}
