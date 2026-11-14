let secretManagerClient;
let cachedAwsKey;
let cachedAwsKeyUntil = 0;

export function gnaniIsConfigured() {
  return Boolean(process.env.GNANI_API_KEY || process.env.GNANI_API_KEY_SECRET_ARN);
}

export async function getGnaniApiKey() {
  if (process.env.GNANI_API_KEY) return process.env.GNANI_API_KEY;

  const secretArn = process.env.GNANI_API_KEY_SECRET_ARN;
  if (!secretArn) return null;
  if (cachedAwsKey && Date.now() < cachedAwsKeyUntil) return cachedAwsKey;

  if (!secretManagerClient) {
    const { SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    secretManagerClient = new SecretsManagerClient({});
  }
  const { GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const secret = await secretManagerClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const apiKey = typeof secret.SecretString === 'string'
    ? secret.SecretString.trim()
    : secret.SecretBinary ? Buffer.from(secret.SecretBinary).toString('utf8').trim() : '';
  if (!apiKey) throw new Error('Gnani API key secret is empty or not a string.');

  cachedAwsKey = apiKey;
  cachedAwsKeyUntil = Date.now() + 5 * 60 * 1000;
  return cachedAwsKey;
}
