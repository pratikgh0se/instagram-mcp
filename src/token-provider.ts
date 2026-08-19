export interface TokenProvider {
  getAccessToken(accountId?: string): Promise<string>;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly accessToken: string) {}

  async getAccessToken(): Promise<string> {
    return this.accessToken;
  }
}
