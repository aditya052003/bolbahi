export function gnaniIsConfigured(environment = process.env) {
  return Boolean(environment.GNANI_API_KEY?.trim());
}

export async function getGnaniApiKey(environment = process.env) {
  return environment.GNANI_API_KEY?.trim() || null;
}
