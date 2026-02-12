export const formatRendererError = (
  error: unknown,
  fallbackMessage = 'Renderer initialization failed',
): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return fallbackMessage
}
