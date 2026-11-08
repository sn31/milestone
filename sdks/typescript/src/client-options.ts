import type { TokenProvider } from "./core/auth/credentials.js";
import type { CoreClientOptions } from "./core/client-options.js";

export type ClientOptions = SdkClientOptions & CoreClientOptions;

type SdkClientOptions = ServerOptions & {
  /** One of usr_client, usr_freelancer, usr_partner. Demo stand-in for sign-in. */
  readonly roleCookie?: TokenProvider | undefined;
  /** An agent mandate token (msa_...), shown once when the mandate is created. */
  readonly mandateToken?: TokenProvider | undefined;
};

type ServerOptions = {
  /** Local development */
  readonly serverOptions?: {
    baseUrl?: string;
  };
};
