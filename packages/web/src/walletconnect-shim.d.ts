declare module "@walletconnect/sign-client" {
  export const SignClient: {
    init(opts: {
      projectId: string;
      metadata: {
        name: string;
        description: string;
        url: string;
        icons: string[];
      };
    }): Promise<{
      connect(opts: unknown): Promise<{
        uri?: string;
        approval: () => Promise<{
          topic: string;
          namespaces?: {
            cosmos?: { accounts?: string[] };
          };
        }>;
      }>;
      disconnect(opts: {
        topic: string;
        reason: { code: number; message: string };
      }): Promise<void>;
      request(opts: unknown): Promise<unknown>;
    }>;
  };
}
