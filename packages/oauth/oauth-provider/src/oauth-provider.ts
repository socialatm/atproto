import type { IncomingMessage, ServerResponse } from 'node:http'
import createHttpError from 'http-errors'
import type { Redis, RedisOptions } from 'ioredis'
import { ZodError, z } from 'zod'
import { Jwks, Keyset } from '@atproto/jwk'
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  OAuthAccessToken,
  OAuthAuthorizationCodeGrantTokenRequest,
  OAuthAuthorizationRequestJar,
  OAuthAuthorizationRequestPar,
  OAuthAuthorizationRequestParameters,
  OAuthAuthorizationRequestQuery,
  OAuthAuthorizationServerMetadata,
  OAuthClientCredentials,
  OAuthClientCredentialsNone,
  OAuthClientMetadata,
  OAuthIntrospectionResponse,
  OAuthParResponse,
  OAuthRefreshTokenGrantTokenRequest,
  OAuthTokenIdentification,
  OAuthTokenRequest,
  OAuthTokenResponse,
  OAuthTokenType,
  atprotoLoopbackClientMetadata,
  oauthAuthorizationRequestParSchema,
  oauthAuthorizationRequestParametersSchema,
  oauthAuthorizationRequestQuerySchema,
  oauthClientCredentialsSchema,
  oauthTokenIdentificationSchema,
  oauthTokenRequestSchema,
} from '@atproto/oauth-types'
import { safeFetchWrap } from '@atproto-labs/fetch-node'
import { SimpleStore } from '@atproto-labs/simple-store'
import { SimpleStoreMemory } from '@atproto-labs/simple-store-memory'
import { AccessTokenType } from './access-token/access-token-type.js'
import { AccountManager } from './account/account-manager.js'
import {
  AccountStore,
  DeviceAccountInfo,
  asAccountStore,
  handleSchema,
  resetPasswordConfirmDataSchema,
  resetPasswordRequestDataSchema,
} from './account/account-store.js'
import { Account } from './account/account.js'
import { signInDataSchema } from './account/sign-in-data.js'
import { signUpInputSchema } from './account/sign-up-input.js'
import { authorizeAssetsMiddleware } from './assets/assets-middleware.js'
import { ClientAuth, authJwkThumbprint } from './client/client-auth.js'
import {
  ClientManager,
  LoopbackMetadataGetter,
} from './client/client-manager.js'
import { ClientStore, ifClientStore } from './client/client-store.js'
import { Client } from './client/client.js'
import { AUTHENTICATION_MAX_AGE, TOKEN_MAX_AGE } from './constants.js'
import { DeviceId } from './device/device-id.js'
import {
  DeviceInfo,
  DeviceManager,
  DeviceManagerOptions,
  deviceManagerOptionsSchema,
} from './device/device-manager.js'
import { DeviceStore, asDeviceStore } from './device/device-store.js'
import { AccessDeniedError } from './errors/access-denied-error.js'
import { AccountSelectionRequiredError } from './errors/account-selection-required-error.js'
import { ConsentRequiredError } from './errors/consent-required-error.js'
import { InvalidClientError } from './errors/invalid-client-error.js'
import { InvalidGrantError } from './errors/invalid-grant-error.js'
import { InvalidParametersError } from './errors/invalid-parameters-error.js'
import { InvalidRequestError } from './errors/invalid-request-error.js'
import { LoginRequiredError } from './errors/login-required-error.js'
import { UnauthorizedClientError } from './errors/unauthorized-client-error.js'
import { WWWAuthenticateError } from './errors/www-authenticate-error.js'
import { HcaptchaConfig } from './lib/hcaptcha.js'
import {
  Handler,
  Middleware,
  Router,
  cacheControlMiddleware,
  combineMiddlewares,
  parseHttpRequest,
  setupCsrfToken,
  staticJsonMiddleware,
  validateCsrfToken,
  validateFetchDest,
  validateFetchMode,
  validateFetchSite,
  validateReferer,
  validateSameOrigin,
  writeJson,
} from './lib/http/index.js'
import {
  RequestMetadata,
  extractLocales,
  negotiateResponseContent as negotiateContent,
} from './lib/http/request.js'
import { dateToEpoch, dateToRelativeSeconds } from './lib/util/date.js'
import { Awaitable, Override } from './lib/util/type.js'
import { CustomMetadata, buildMetadata } from './metadata/build-metadata.js'
import { OAuthHooks, SignInData, SignUpData } from './oauth-hooks.js'
import { OAuthVerifier, OAuthVerifierOptions } from './oauth-verifier.js'
import { AuthorizationResultAuthorize } from './output/build-authorize-data.js'
import {
  Branding,
  BrandingInput,
  Customization,
  CustomizationInput,
  customizationSchema,
} from './output/build-customization-data.js'
import {
  buildErrorPayload,
  buildErrorStatus,
} from './output/build-error-payload.js'
import { OutputManager } from './output/output-manager.js'
import {
  AuthorizationResultRedirect,
  sendAuthorizeRedirect,
} from './output/send-authorize-redirect.js'
import { ReplayStore, ifReplayStore } from './replay/replay-store.js'
import { codeSchema } from './request/code.js'
import { RequestInfo } from './request/request-info.js'
import { RequestManager } from './request/request-manager.js'
import { RequestStoreMemory } from './request/request-store-memory.js'
import { RequestStoreRedis } from './request/request-store-redis.js'
import { RequestStore, ifRequestStore } from './request/request-store.js'
import { RequestUri, requestUriSchema } from './request/request-uri.js'
import { isTokenId } from './token/token-id.js'
import { TokenManager } from './token/token-manager.js'
import { TokenStore, asTokenStore } from './token/token-store.js'
import { VerifyTokenClaimsOptions } from './token/verify-token-claims.js'

export {
  type Branding,
  type BrandingInput,
  type CustomMetadata,
  type Customization,
  type CustomizationInput,
  type Handler,
  type HcaptchaConfig,
  Keyset,
  type OAuthAuthorizationServerMetadata,
}

type ApiContext = {
  requestUri: RequestUri
  deviceId: DeviceId
  deviceMetadata: RequestMetadata
}

export type ErrorHandler<
  Req extends IncomingMessage = IncomingMessage,
  Res extends ServerResponse = ServerResponse,
> = (req: Req, res: Res, err: unknown, message: string) => void

export type RouterOptions<
  Req extends IncomingMessage = IncomingMessage,
  Res extends ServerResponse = ServerResponse,
> = {
  onError?: ErrorHandler<Req, Res>
}

export type OAuthProviderOptions = Override<
  OAuthVerifierOptions & OAuthHooks & DeviceManagerOptions & CustomizationInput,
  {
    /**
     * Maximum age a device/account session can be before requiring
     * re-authentication.
     */
    authenticationMaxAge?: number

    /**
     * Maximum age access & id tokens can be before requiring a refresh.
     */
    tokenMaxAge?: number

    /**
     * Additional metadata to be included in the discovery document.
     */
    metadata?: CustomMetadata

    /**
     * A custom fetch function that can be used to fetch the client metadata from
     * the internet. By default, the fetch function is a safeFetchWrap() function
     * that protects against SSRF attacks, large responses & known bad domains. If
     * you want to disable all protections, you can provide `globalThis.fetch` as
     * fetch function.
     */
    safeFetch?: typeof globalThis.fetch

    /**
     * A redis instance to use for replay protection. If not provided, replay
     * protection will use memory storage.
     */
    redis?: Redis | RedisOptions | string

    /**
     * This will be used as the default store for all the stores. If a store is
     * not provided, this store will be used instead. If the `store` does not
     * implement a specific store, a runtime error will be thrown. Make sure that
     * this store implements all the interfaces not provided in the other
     * `<name>Store` options.
     */
    store?: Partial<
      AccountStore &
        ClientStore &
        DeviceStore &
        ReplayStore &
        RequestStore &
        TokenStore
    >

    accountStore?: AccountStore
    clientStore?: ClientStore
    deviceStore?: DeviceStore
    replayStore?: ReplayStore
    requestStore?: RequestStore
    tokenStore?: TokenStore

    /**
     * In order to speed up the client fetching process, you can provide a cache
     * to store HTTP responses.
     *
     * @note the cached entries should automatically expire after a certain time (typically 10 minutes)
     */
    clientJwksCache?: SimpleStore<string, Jwks>

    /**
     * In order to speed up the client fetching process, you can provide a cache
     * to store HTTP responses.
     *
     * @note the cached entries should automatically expire after a certain time (typically 10 minutes)
     */
    clientMetadataCache?: SimpleStore<string, OAuthClientMetadata>

    /**
     * In order to enable loopback clients, you can provide a function that
     * returns the client metadata for a given loopback URL. This is useful for
     * development and testing purposes. This function is not called for internet
     * clients.
     *
     * @default is as specified by ATPROTO
     */
    loopbackMetadata?: null | false | LoopbackMetadataGetter
  }
>

export class OAuthProvider extends OAuthVerifier {
  public readonly metadata: OAuthAuthorizationServerMetadata

  public readonly authenticationMaxAge: number

  public readonly accountManager: AccountManager
  public readonly deviceManager: DeviceManager
  public readonly clientManager: ClientManager
  public readonly requestManager: RequestManager
  public readonly tokenManager: TokenManager
  public readonly outputManager: OutputManager

  public constructor({
    metadata,
    authenticationMaxAge = AUTHENTICATION_MAX_AGE,
    tokenMaxAge = TOKEN_MAX_AGE,

    safeFetch = safeFetchWrap(),
    redis,
    store, // compound store implementation

    // Requires stores
    accountStore = asAccountStore(store),
    deviceStore = asDeviceStore(store),
    tokenStore = asTokenStore(store),

    // These are optional
    clientStore = ifClientStore(store),
    replayStore = ifReplayStore(store),
    requestStore = ifRequestStore(store),

    clientJwksCache = new SimpleStoreMemory({
      maxSize: 50_000_000,
      ttl: 600e3,
    }),
    clientMetadataCache = new SimpleStoreMemory({
      maxSize: 50_000_000,
      ttl: 600e3,
    }),

    loopbackMetadata = atprotoLoopbackClientMetadata,

    // OAuthHooks &
    // OAuthVerifierOptions &
    // DeviceManagerOptions &
    // Customization
    ...rest
  }: OAuthProviderOptions) {
    const customization: Customization = customizationSchema.parse(rest)
    const deviceManagerOptions: DeviceManagerOptions =
      deviceManagerOptionsSchema.parse(rest)

    // @NOTE: hooks don't really need a type parser, as all zod can actually
    // check at runtime is the fact that the values are functions. The only way
    // we would benefit from zod here would be to wrap the functions with a
    // validator for the provided function's return types, which we do not add
    // because it would impact runtime performance and we trust the users of
    // this lib (basically ourselves) to rely on the typing system to ensure the
    // correct types are returned.
    const hooks: OAuthHooks = rest

    // @NOTE: validation of super params (if we wanted to implement it) should
    // be the responsibility of the super class.
    const superOptions: OAuthVerifierOptions = rest

    super({ replayStore, redis, ...superOptions })

    requestStore ??= redis
      ? new RequestStoreRedis({ redis })
      : new RequestStoreMemory()

    this.authenticationMaxAge = authenticationMaxAge
    this.metadata = buildMetadata(this.issuer, this.keyset, metadata)

    this.deviceManager = new DeviceManager(deviceStore, deviceManagerOptions)
    this.outputManager = new OutputManager(customization)
    this.accountManager = new AccountManager(
      this.issuer,
      accountStore,
      hooks,
      customization,
    )
    this.clientManager = new ClientManager(
      this.metadata,
      this.keyset,
      hooks,
      clientStore || null,
      loopbackMetadata || null,
      safeFetch,
      clientJwksCache,
      clientMetadataCache,
    )
    this.requestManager = new RequestManager(
      requestStore,
      this.signer,
      this.metadata,
      hooks,
    )
    this.tokenManager = new TokenManager(
      tokenStore,
      this.signer,
      hooks,
      this.accessTokenType,
      tokenMaxAge,
    )
  }

  get jwks() {
    return this.keyset.publicJwks
  }

  protected loginRequired(
    client: Client,
    parameters: OAuthAuthorizationRequestParameters,
    info: DeviceAccountInfo,
  ) {
    /** in seconds */
    const authAge = (Date.now() - info.authenticatedAt.getTime()) / 1e3

    // Fool-proof (invalid date, or suspiciously in the future)
    if (!Number.isFinite(authAge) || authAge < 0) {
      return true
    }

    return authAge >= this.authenticationMaxAge
  }

  protected async authenticateClient(
    credentials: OAuthClientCredentials,
  ): Promise<[Client, ClientAuth]> {
    const client = await this.clientManager.getClient(credentials.client_id)
    const { clientAuth, nonce } = await client.verifyCredentials(credentials, {
      audience: this.issuer,
    })

    if (
      client.metadata.application_type === 'native' &&
      clientAuth.method !== 'none'
    ) {
      // https://datatracker.ietf.org/doc/html/rfc8252#section-8.4
      //
      // > Except when using a mechanism like Dynamic Client Registration
      // > [RFC7591] to provision per-instance secrets, native apps are
      // > classified as public clients, as defined by Section 2.1 of OAuth 2.0
      // > [RFC6749]; they MUST be registered with the authorization server as
      // > such. Authorization servers MUST record the client type in the client
      // > registration details in order to identify and process requests
      // > accordingly.

      throw new InvalidGrantError(
        'Native clients must authenticate using "none" method',
      )
    }

    if (nonce != null) {
      const unique = await this.replayManager.uniqueAuth(nonce, client.id)
      if (!unique) {
        throw new InvalidGrantError(`${clientAuth.method} jti reused`)
      }
    }

    return [client, clientAuth]
  }

  protected async decodeJAR(
    client: Client,
    input: OAuthAuthorizationRequestJar,
  ): Promise<
    | {
        payload: OAuthAuthorizationRequestParameters
      }
    | {
        payload: OAuthAuthorizationRequestParameters
        protectedHeader: { kid: string; alg: string }
        jkt: string
      }
  > {
    const result = await client.decodeRequestObject(input.request)
    const payload = oauthAuthorizationRequestParametersSchema.parse(
      result.payload,
    )

    if (!result.payload.jti) {
      throw new InvalidParametersError(
        payload,
        'Request object must contain a jti claim',
      )
    }

    if (!(await this.replayManager.uniqueJar(result.payload.jti, client.id))) {
      throw new InvalidParametersError(
        payload,
        'Request object jti is not unique',
      )
    }

    if ('protectedHeader' in result) {
      if (!result.protectedHeader.kid) {
        throw new InvalidParametersError(payload, 'Missing "kid" in header')
      }

      return {
        jkt: await authJwkThumbprint(result.key),
        payload,
        protectedHeader: result.protectedHeader as {
          alg: string
          kid: string
        },
      }
    }

    if ('header' in result) {
      return {
        payload,
      }
    }

    // Should never happen
    throw new Error('Invalid request object')
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/rfc9126}
   */
  protected async pushedAuthorizationRequest(
    credentials: OAuthClientCredentials,
    authorizationRequest: OAuthAuthorizationRequestPar,
    dpopJkt: null | string,
  ): Promise<OAuthParResponse> {
    try {
      const [client, clientAuth] = await this.authenticateClient(credentials)

      const { payload: parameters } =
        'request' in authorizationRequest // Handle JAR
          ? await this.decodeJAR(client, authorizationRequest)
          : { payload: authorizationRequest }

      const { uri, expiresAt } =
        await this.requestManager.createAuthorizationRequest(
          client,
          clientAuth,
          parameters,
          null,
          dpopJkt,
        )

      return {
        request_uri: uri,
        expires_in: dateToRelativeSeconds(expiresAt),
      }
    } catch (err) {
      // https://datatracker.ietf.org/doc/html/rfc9126#section-2.3-1
      // > Since initial processing of the pushed authorization request does not
      // > involve resource owner interaction, error codes related to user
      // > interaction, such as "access_denied", are never returned.
      if (err instanceof AccessDeniedError) {
        throw new InvalidRequestError(err.error_description, err)
      }
      throw err
    }
  }

  private async processAuthorizationRequest(
    client: Client,
    deviceId: DeviceId,
    query: OAuthAuthorizationRequestQuery,
  ): Promise<RequestInfo> {
    if ('request_uri' in query) {
      const requestUri = await requestUriSchema
        .parseAsync(query.request_uri, { path: ['query', 'request_uri'] })
        .catch(throwInvalidRequest)

      return this.requestManager.get(requestUri, deviceId, client.id)
    }

    if ('request' in query) {
      const requestObject = await this.decodeJAR(client, query)

      if ('protectedHeader' in requestObject && requestObject.protectedHeader) {
        // Allow using signed JAR during "/authorize" as client authentication.
        // This allows clients to skip PAR to initiate trusted sessions.
        const clientAuth: ClientAuth = {
          method: CLIENT_ASSERTION_TYPE_JWT_BEARER,
          kid: requestObject.protectedHeader.kid,
          alg: requestObject.protectedHeader.alg,
          jkt: requestObject.jkt,
        }

        return this.requestManager.createAuthorizationRequest(
          client,
          clientAuth,
          requestObject.payload,
          deviceId,
          null,
        )
      }

      return this.requestManager.createAuthorizationRequest(
        client,
        { method: 'none' },
        requestObject.payload,
        deviceId,
        null,
      )
    }

    return this.requestManager.createAuthorizationRequest(
      client,
      { method: 'none' },
      query,
      deviceId,
      null,
    )
  }

  private async deleteRequest(
    requestUri: RequestUri,
    parameters: OAuthAuthorizationRequestParameters,
  ) {
    try {
      await this.requestManager.delete(requestUri)
    } catch (err) {
      throw AccessDeniedError.from(parameters, err)
    }
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-11#section-4.1.1}
   */
  protected async authorize(
    clientCredentials: OAuthClientCredentialsNone,
    query: OAuthAuthorizationRequestQuery,
    deviceId: DeviceId,
    deviceMetadata: RequestMetadata,
  ): Promise<AuthorizationResultRedirect | AuthorizationResultAuthorize> {
    const { issuer } = this

    // If there is a chance to redirect the user to the client, let's do
    // it by wrapping the error in an AccessDeniedError.
    const accessDeniedCatcher =
      'redirect_uri' in query
        ? (err: unknown): never => {
            // https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-11#section-4.1.2.1
            throw AccessDeniedError.from(query, err, 'invalid_request')
          }
        : null

    const client = await this.clientManager
      .getClient(clientCredentials.client_id)
      .catch(accessDeniedCatcher)

    const { clientAuth, parameters, uri } =
      await this.processAuthorizationRequest(client, deviceId, query).catch(
        accessDeniedCatcher,
      )

    try {
      const sessions = await this.getSessions(
        client,
        clientAuth,
        deviceId,
        parameters,
      )

      if (parameters.prompt === 'none') {
        const ssoSessions = sessions.filter((s) => s.matchesHint)
        if (ssoSessions.length > 1) {
          throw new AccountSelectionRequiredError(parameters)
        }
        if (ssoSessions.length < 1) {
          throw new LoginRequiredError(parameters)
        }

        const ssoSession = ssoSessions[0]!
        if (ssoSession.loginRequired) {
          throw new LoginRequiredError(parameters)
        }
        if (ssoSession.consentRequired) {
          throw new ConsentRequiredError(parameters)
        }

        const code = await this.requestManager.setAuthorized(
          uri,
          client,
          ssoSession.account,
          deviceId,
          deviceMetadata,
        )

        return { issuer, client, parameters, redirect: { code } }
      }

      // Automatic SSO when a did was provided
      if (parameters.prompt == null && parameters.login_hint != null) {
        const ssoSessions = sessions.filter((s) => s.matchesHint)
        if (ssoSessions.length === 1) {
          const ssoSession = ssoSessions[0]!
          if (!ssoSession.loginRequired && !ssoSession.consentRequired) {
            const code = await this.requestManager.setAuthorized(
              uri,
              client,
              ssoSession.account,
              deviceId,
              deviceMetadata,
            )

            return { issuer, client, parameters, redirect: { code } }
          }
        }
      }

      return {
        issuer,
        client,
        parameters,
        authorize: {
          uri,
          sessions,
          scopeDetails: parameters.scope
            ?.split(/\s+/)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
            .map((scope) => ({
              scope,
              // @TODO Allow to customize the scope descriptions (e.g.
              // using a hook)
              description: undefined,
            })),
        },
      }
    } catch (err) {
      await this.deleteRequest(uri, parameters)

      // Not using accessDeniedCatcher here because "parameters" will most
      // likely contain the redirect_uri (using the client default).
      throw AccessDeniedError.from(parameters, err)
    }
  }

  protected async getSessions(
    client: Client,
    clientAuth: ClientAuth,
    deviceId: DeviceId,
    parameters: OAuthAuthorizationRequestParameters,
  ): Promise<
    {
      account: Account
      info: DeviceAccountInfo

      selected: boolean
      loginRequired: boolean
      consentRequired: boolean

      matchesHint: boolean
    }[]
  > {
    const accounts = await this.accountManager.list(deviceId)

    const hint = parameters.login_hint
    const matchesHint = (account: Account): boolean =>
      (!!account.sub && account.sub === hint) ||
      (!!account.preferred_username && account.preferred_username === hint)

    return accounts.map(({ account, info }) => ({
      account,
      info,

      selected:
        parameters.prompt !== 'select_account' &&
        matchesHint(account) &&
        // If an account uses the sub of another account as preferred_username,
        // there might be multiple accounts matching the hint. In that case,
        // selecting the account automatically may have unexpected results (i.e.
        // not able to login using desired account).
        accounts.reduce(
          (acc, a) => acc + (matchesHint(a.account) ? 1 : 0),
          0,
        ) === 1,
      loginRequired:
        parameters.prompt === 'login' ||
        this.loginRequired(client, parameters, info),
      consentRequired:
        parameters.prompt === 'consent' ||
        // @TODO the "authorizedClients" should also include the scopes that
        // were already authorized for the client. Otherwise a client could
        // use silent authentication to get additional scopes without consent.
        !info.authorizedClients.includes(client.id),

      matchesHint: hint == null || matchesHint(account),
    }))
  }

  protected async signUp(
    { requestUri, deviceId, deviceMetadata }: ApiContext,
    data: SignUpData,
  ): Promise<{
    account: Account
    consentRequired: boolean
  }> {
    const { clientId } = await this.requestManager.get(requestUri, deviceId)

    const client = await this.clientManager.getClient(clientId)

    const { account } = await this.accountManager.signUp(
      data,
      deviceId,
      deviceMetadata,
    )

    return {
      account,
      consentRequired: !client.info.isFirstParty,
    }
  }

  protected async signIn(
    { requestUri, deviceId, deviceMetadata }: ApiContext,
    data: SignInData,
  ): Promise<{
    account: Account
    consentRequired: boolean
  }> {
    // Ensure the request is still valid (and update the request expiration)
    // @TODO use the returned scopes to determine if consent is required
    const { clientId } = await this.requestManager.get(requestUri, deviceId)

    const client = await this.clientManager.getClient(clientId)

    const { account, info } = await this.accountManager.signIn(
      data,
      deviceId,
      deviceMetadata,
    )

    return {
      account,
      consentRequired: client.info.isFirstParty
        ? false
        : // @TODO: the "authorizedClients" should also include the scopes that
          // were already authorized for the client. Otherwise a client could
          // use silent authentication to get additional scopes without consent.
          !info.authorizedClients.includes(client.id),
    }
  }

  protected async acceptRequest(
    { requestUri, deviceId, deviceMetadata }: ApiContext,
    sub: string,
  ): Promise<AuthorizationResultRedirect> {
    const { issuer } = this

    const { parameters, clientId, clientAuth } = await this.requestManager.get(
      requestUri,
      deviceId,
    )

    const client = await this.clientManager.getClient(clientId)

    try {
      // @TODO Currently, a user can "accept" a request for any did that sing-in
      // on the device, even if "remember" was set to false.
      const { account, info } = await this.accountManager.get(deviceId, sub)

      // The user is trying to authorize without a fresh login
      if (this.loginRequired(client, parameters, info)) {
        throw new LoginRequiredError(
          parameters,
          'Account authentication required.',
        )
      }

      const code = await this.requestManager.setAuthorized(
        requestUri,
        client,
        account,
        deviceId,
        deviceMetadata,
      )

      await this.accountManager.addAuthorizedClient(
        deviceId,
        account,
        client,
        clientAuth,
      )

      return { issuer, parameters, redirect: { code } }
    } catch (err) {
      await this.deleteRequest(requestUri, parameters)

      throw AccessDeniedError.from(parameters, err)
    }
  }

  protected async rejectRequest({
    requestUri,
    deviceId,
  }: ApiContext): Promise<AuthorizationResultRedirect> {
    const { parameters } = await this.requestManager.get(requestUri, deviceId)

    await this.deleteRequest(requestUri, parameters)

    return {
      issuer: this.issuer,
      parameters: parameters,
      redirect: {
        error: 'access_denied',
        error_description: 'Access denied',
      },
    }
  }

  protected async token(
    clientCredentials: OAuthClientCredentials,
    clientMetadata: RequestMetadata,
    request: OAuthTokenRequest,
    dpopJkt: null | string,
  ): Promise<OAuthTokenResponse> {
    const [client, clientAuth] =
      await this.authenticateClient(clientCredentials)

    if (!this.metadata.grant_types_supported?.includes(request.grant_type)) {
      throw new InvalidGrantError(
        `Grant type "${request.grant_type}" is not supported by the server`,
      )
    }

    if (!client.metadata.grant_types.includes(request.grant_type)) {
      throw new InvalidGrantError(
        `"${request.grant_type}" grant type is not allowed for this client`,
      )
    }

    if (request.grant_type === 'authorization_code') {
      return this.codeGrant(
        client,
        clientAuth,
        clientMetadata,
        request,
        dpopJkt,
      )
    }

    if (request.grant_type === 'refresh_token') {
      return this.refreshTokenGrant(
        client,
        clientAuth,
        clientMetadata,
        request,
        dpopJkt,
      )
    }

    throw new InvalidGrantError(
      `Grant type "${request.grant_type}" not supported`,
    )
  }

  protected async codeGrant(
    client: Client,
    clientAuth: ClientAuth,
    clientMetadata: RequestMetadata,
    input: OAuthAuthorizationCodeGrantTokenRequest,
    dpopJkt: null | string,
  ): Promise<OAuthTokenResponse> {
    try {
      const code = codeSchema.parse(input.code)

      const { sub, deviceId, parameters } = await this.requestManager.findCode(
        client,
        clientAuth,
        code,
      )

      // the following check prevents re-use of PKCE challenges, enforcing the
      // clients to generate a new challenge for each authorization request. The
      // replay manager typically prevents replay over a certain time frame,
      // which might not cover the entire lifetime of the token (depending on
      // the implementation of the replay store). For this reason, we should
      // ideally ensure that the code_challenge was not already used by any
      // existing token or any other pending request.
      //
      // The current implementation will cause client devs not issuing a new
      // code challenge for each authorization request to fail, which should be
      // a good enough incentive to follow the best practices, until we have a
      // better implementation.
      //
      // @TODO: Use tokenManager to ensure uniqueness of code_challenge
      if (parameters.code_challenge) {
        const unique = await this.replayManager.uniqueCodeChallenge(
          parameters.code_challenge,
        )
        if (!unique) {
          throw new InvalidGrantError(
            'code_challenge',
            'Code challenge already used',
          )
        }
      }

      const { account, info } = await this.accountManager.get(deviceId, sub)

      return await this.tokenManager.create(
        client,
        clientAuth,
        clientMetadata,
        account,
        { id: deviceId, info },
        parameters,
        input,
        dpopJkt,
      )
    } catch (err) {
      // If a token is replayed, requestManager.findCode will throw. In that
      // case, we need to revoke any token that was issued for this code.

      await this.tokenManager.revoke(input.code)

      // @TODO (?) in order to protect the user, we should maybe also mark the
      // account-device association as expired ?

      throw err
    }
  }

  async refreshTokenGrant(
    client: Client,
    clientAuth: ClientAuth,
    clientMetadata: RequestMetadata,
    input: OAuthRefreshTokenGrantTokenRequest,
    dpopJkt: null | string,
  ): Promise<OAuthTokenResponse> {
    return this.tokenManager.refresh(
      client,
      clientAuth,
      clientMetadata,
      input,
      dpopJkt,
    )
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/rfc7009#section-2.1 rfc7009}
   */
  protected async revoke({ token }: OAuthTokenIdentification) {
    // @TODO this should also remove the account-device association (or, at
    // least, mark it as expired)
    await this.tokenManager.revoke(token)
  }

  /**
   * @see {@link https://datatracker.ietf.org/doc/html/rfc7662#section-2.1 rfc7662}
   */
  protected async introspect(
    credentials: OAuthClientCredentials,
    { token }: OAuthTokenIdentification,
  ): Promise<OAuthIntrospectionResponse> {
    const [client, clientAuth] = await this.authenticateClient(credentials)

    // RFC7662 states the following:
    //
    // > To prevent token scanning attacks, the endpoint MUST also require some
    // > form of authorization to access this endpoint, such as client
    // > authentication as described in OAuth 2.0 [RFC6749] or a separate OAuth
    // > 2.0 access token such as the bearer token described in OAuth 2.0 Bearer
    // > Token Usage [RFC6750]. The methods of managing and validating these
    // > authentication credentials are out of scope of this specification.
    if (clientAuth.method === 'none') {
      throw new UnauthorizedClientError('Client authentication required')
    }

    const start = Date.now()
    try {
      const tokenInfo = await this.tokenManager.clientTokenInfo(
        client,
        clientAuth,
        token,
      )

      return {
        active: true,

        scope: tokenInfo.data.parameters.scope,
        client_id: tokenInfo.data.clientId,
        username: tokenInfo.account.preferred_username,
        token_type: tokenInfo.data.parameters.dpop_jkt ? 'DPoP' : 'Bearer',
        authorization_details: tokenInfo.data.details ?? undefined,

        aud: tokenInfo.account.aud,
        exp: dateToEpoch(tokenInfo.data.expiresAt),
        iat: dateToEpoch(tokenInfo.data.updatedAt),
        iss: this.signer.issuer,
        jti: tokenInfo.id,
        sub: tokenInfo.account.sub,
      }
    } catch (err) {
      // Prevent brute force & timing attack (only for inactive tokens)
      await new Promise((r) => setTimeout(r, 750 - (Date.now() - start)))

      return {
        active: false,
      }
    }
  }

  protected override async authenticateToken(
    tokenType: OAuthTokenType,
    token: OAuthAccessToken,
    dpopJkt: string | null,
    verifyOptions?: VerifyTokenClaimsOptions,
  ) {
    if (isTokenId(token)) {
      this.assertTokenTypeAllowed(tokenType, AccessTokenType.id)

      return this.tokenManager.authenticateTokenId(
        tokenType,
        token,
        dpopJkt,
        verifyOptions,
      )
    }

    return super.authenticateToken(tokenType, token, dpopJkt, verifyOptions)
  }

  /**
   * @returns An http request handler that can be used with node's http server
   * or as a middleware with express / connect.
   */
  public httpHandler<
    T = void,
    Req extends IncomingMessage = IncomingMessage,
    Res extends ServerResponse = ServerResponse,
  >(options?: RouterOptions<Req, Res>): Handler<T, Req, Res> {
    const router = this.buildRouter<T, Req, Res>(options)
    return router.buildHandler()
  }

  public buildRouter<
    T = void,
    Req extends IncomingMessage = IncomingMessage,
    Res extends ServerResponse = ServerResponse,
  >(options?: RouterOptions<Req, Res>): Router<T, Req, Res> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this
    const issuerUrl = new URL(server.issuer)
    const issuerOrigin = issuerUrl.origin
    const router = new Router<T, Req, Res>(issuerUrl)

    // Utils

    const csrfCookie = (requestUri: RequestUri) => `csrf-${requestUri}`
    const onError: null | ErrorHandler<Req, Res> =
      options?.onError ??
      (process.env['NODE_ENV'] === 'development'
        ? (req, res, err, msg) => {
            console.error(`OAuthProvider error (${msg}):`, err)
          }
        : null)

    // CORS preflight
    const corsHeaders: Middleware = function (req, res, next) {
      res.setHeader('Access-Control-Max-Age', '86400') // 1 day

      // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Origin
      //
      // > For requests without credentials, the literal value "*" can be
      // > specified as a wildcard; the value tells browsers to allow
      // > requesting code from any origin to access the resource.
      // > Attempting to use the wildcard with credentials results in an
      // > error.
      //
      // A "*" is safer to use than reflecting the request origin.
      res.setHeader('Access-Control-Allow-Origin', '*')

      // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Methods
      // > The value "*" only counts as a special wildcard value for
      // > requests without credentials (requests without HTTP cookies or
      // > HTTP authentication information). In requests with credentials,
      // > it is treated as the literal method name "*" without special
      // > semantics.
      res.setHeader('Access-Control-Allow-Methods', '*')

      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,DPoP')

      next()
    }

    const corsPreflight: Middleware = combineMiddlewares([
      corsHeaders,
      (req, res) => {
        res.writeHead(200).end()
      },
    ])

    /**
     * Wrap an OAuth endpoint in a middleware that will set the appropriate
     * response headers and format the response as JSON.
     */
    const jsonHandler = <T, TReq extends Req, TRes extends Res, Payload>(
      buildJson: (
        this: T,
        req: TReq,
        res: TRes,
      ) => Awaitable<{ payload: Payload; status?: number }>,
    ): Handler<T, TReq, TRes> =>
      async function (req, res) {
        // https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Pragma', 'no-cache')

        // Ensure we can agree on a content encoding & type before starting to
        // build the JSON response.
        if (!negotiateContent(req, ['application/json'])) {
          throw createHttpError(406, 'Unsupported media type')
        }

        try {
          const { payload, status = 200 } = await buildJson.call(this, req, res)
          writeJson(res, payload, { status })
        } catch (err) {
          onError?.(req, res, err, 'OAuth request error')

          if (!res.headersSent) {
            const payload = buildErrorPayload(err)
            const status = buildErrorStatus(err)
            writeJson(res, payload, { status })
          } else {
            res.destroy()
          }
        }
      }

    const oauthHandler = <T, TReq extends Req, TRes extends Res, Payload>(
      buildOAuthResponse: (this: T, req: TReq, res: TRes) => Awaitable<Payload>,
      status?: number,
    ) =>
      combineMiddlewares([
        corsHeaders,
        jsonHandler<T, TReq, TRes, Payload>(async function (req, res) {
          try {
            // https://datatracker.ietf.org/doc/html/rfc9449#section-8.2
            const dpopNonce = server.nextDpopNonce()
            if (dpopNonce) {
              const name = 'DPoP-Nonce'
              res.setHeader(name, dpopNonce)
              res.appendHeader('Access-Control-Expose-Headers', name)
            }

            const payload = await buildOAuthResponse.call(this, req, res)
            return { payload, status }
          } catch (err) {
            if (!res.headersSent && err instanceof WWWAuthenticateError) {
              const name = 'WWW-Authenticate'
              res.setHeader(name, err.wwwAuthenticateHeader)
              res.appendHeader('Access-Control-Expose-Headers', name)
            }

            throw err
          }
        }),
      ])

    const apiHandler = <
      T,
      TReq extends Req,
      TRes extends Res,
      S extends z.ZodTypeAny,
      Payload,
    >(
      inputSchema: S,
      buildJson: (
        this: T,
        req: TReq,
        res: TRes,
        input: z.infer<S>,
        context: ApiContext,
      ) => Awaitable<Payload>,
      status?: number,
    ) =>
      jsonHandler<T, TReq, TRes, Payload>(async function (req, res) {
        validateFetchMode(req, res, ['same-origin'])
        validateFetchSite(req, res, ['same-origin'])
        validateSameOrigin(req, res, issuerOrigin)
        const referer = validateReferer(req, res, {
          origin: issuerOrigin,
          pathname: '/oauth/authorize',
        })

        const requestUri = await requestUriSchema.parseAsync(
          referer.searchParams.get('request_uri'),
          { path: ['query', 'request_uri'] },
        )

        validateCsrfToken(
          req,
          res,
          req.headers['x-csrf-token'],
          csrfCookie(requestUri),
        )

        const { deviceId, deviceMetadata } = await server.deviceManager.load(
          req,
          res,
        )

        const inputRaw = await parseHttpRequest(req, ['json'])
        const input = await inputSchema.parseAsync(inputRaw, { path: ['body'] })

        const context: ApiContext = { requestUri, deviceId, deviceMetadata }
        const payload = await buildJson.call(this, req, res, input, context)
        return { payload, status }
      })

    const navigationHandler = <T, TReq extends Req, TRes extends Res>(
      handler: (this: T, req: TReq, res: TRes) => Awaitable<void>,
    ): Handler<T, TReq, TRes> =>
      async function (req, res) {
        try {
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('Pragma', 'no-cache')

          res.setHeader('Referrer-Policy', 'same-origin')

          validateFetchMode(req, res, ['navigate'])
          validateFetchDest(req, res, ['document'])
          validateSameOrigin(req, res, issuerOrigin)

          await handler.call(this, req, res)
        } catch (err) {
          onError?.(
            req,
            res,
            err,
            `Failed to handle navigation request to "${req.url}"`,
          )

          if (!res.headersSent) {
            await server.outputManager.sendErrorPage(res, err, {
              preferredLocales: extractLocales(req),
            })
          }
        }
      }

    // Simple GET requests fall under the category of "no-cors" request, meaning
    // that the browser will allow any cross-origin request, with credentials,
    // to be sent to the oauth server. The OAuth Server will, however:
    // 1) validate the request origin (see navigationHandler),
    // 2) validate the CSRF token,
    // 3) validate the referer,
    // 4) validate the sec-fetch-site header,
    // 4) validate the sec-fetch-mode header (see navigationHandler),
    // 5) validate the sec-fetch-dest header (see navigationHandler).
    // And will error (refuse to serve the request) if any of these checks fail.
    const sameOriginNavigationHandler = <
      T extends { url: URL },
      TReq extends Req,
      TRes extends Res,
    >(
      handler: (
        this: T,
        req: TReq,
        res: TRes,
        deviceInfo: DeviceInfo,
      ) => Awaitable<void>,
    ): Handler<T, TReq, TRes> =>
      navigationHandler(async function (req, res) {
        validateFetchSite(req, res, ['same-origin'])

        const deviceInfo = await server.deviceManager.load(req, res)

        return handler.call(this, req, res, deviceInfo)
      })

    const authorizeRedirectNavigationHandler = <
      T extends { url: URL },
      TReq extends Req,
      TRes extends Res,
    >(
      handler: (
        this: T,
        req: TReq,
        res: TRes,
        context: ApiContext,
      ) => Awaitable<AuthorizationResultRedirect>,
    ): Handler<T, TReq, TRes> =>
      sameOriginNavigationHandler(async function (req, res, deviceInfo) {
        const referer = validateReferer(req, res, {
          origin: issuerOrigin,
          pathname: '/oauth/authorize',
        })

        const requestUri = await requestUriSchema.parseAsync(
          referer.searchParams.get('request_uri'),
        )

        const csrfToken = this.url.searchParams.get('csrf_token')
        const csrfCookieName = csrfCookie(requestUri)

        // Next line will "clear" the CSRF token cookie, preventing replay of
        // this request (navigating "back" will result in an error).
        validateCsrfToken(req, res, csrfToken, csrfCookieName, true)

        const context: ApiContext = { ...deviceInfo, requestUri }

        const redirect = await handler.call(this, req, res, context)
        return sendAuthorizeRedirect(res, redirect)
      })

    /**
     * Provides a better UX when a request is denied by redirecting to the
     * client with the error details. This will also log any error that caused
     * the access to be denied (such as system errors).
     */
    const accessDeniedToRedirectCatcher = (
      req: Req,
      res: Res,
      err: unknown,
    ): AuthorizationResultRedirect => {
      if (err instanceof AccessDeniedError && err.parameters.redirect_uri) {
        const { cause } = err
        if (cause) onError?.(req, res, cause, 'Access denied')

        return {
          issuer: server.issuer,
          parameters: err.parameters,
          redirect: err.toJSON(),
        }
      }

      throw err
    }

    //- Public OAuth endpoints

    router.options('/.well-known/oauth-authorization-server', corsPreflight)
    router.get(
      '/.well-known/oauth-authorization-server',
      corsHeaders,
      cacheControlMiddleware(300),
      staticJsonMiddleware(server.metadata),
    )

    router.options('/oauth/jwks', corsPreflight)
    router.get(
      '/oauth/jwks',
      corsHeaders,
      cacheControlMiddleware(300),
      staticJsonMiddleware(server.jwks),
    )

    router.options('/oauth/par', corsPreflight)
    router.post(
      '/oauth/par',
      oauthHandler(async function (req, _res) {
        const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

        const credentials = await oauthClientCredentialsSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidRequest)

        const authorizationRequest = await oauthAuthorizationRequestParSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidRequest)

        const dpopJkt = await server.checkDpopProof(
          req.headers['dpop'],
          req.method!,
          this.url,
        )

        return server.pushedAuthorizationRequest(
          credentials,
          authorizationRequest,
          dpopJkt,
        )
      }, 201),
    )
    // https://datatracker.ietf.org/doc/html/rfc9126#section-2.3
    // > If the request did not use the POST method, the authorization server
    // > responds with an HTTP 405 (Method Not Allowed) status code.
    router.all('/oauth/par', (req, res) => {
      res.writeHead(405).end()
    })

    router.options('/oauth/token', corsPreflight)
    router.post(
      '/oauth/token',
      oauthHandler(async function (req, _res) {
        const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

        const clientMetadata =
          await server.deviceManager.getRequestMetadata(req)

        const clientCredentials = await oauthClientCredentialsSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidClient)

        const tokenRequest = await oauthTokenRequestSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidGrant)

        const dpopJkt = await server.checkDpopProof(
          req.headers['dpop'],
          req.method!,
          this.url,
        )

        return server.token(
          clientCredentials,
          clientMetadata,
          tokenRequest,
          dpopJkt,
        )
      }),
    )

    router.options('/oauth/revoke', corsPreflight)
    router.post(
      '/oauth/revoke',
      oauthHandler(async function (req, res) {
        const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

        const tokenIdentification = await oauthTokenIdentificationSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidRequest)

        try {
          await server.revoke(tokenIdentification)
        } catch (err) {
          onError?.(req, res, err, 'Failed to revoke token')
        }

        return {}
      }),
    )
    router.get(
      '/oauth/revoke',
      navigationHandler(async function (req, res) {
        const query = Object.fromEntries(this.url.searchParams)

        const tokenIdentification = await oauthTokenIdentificationSchema
          .parseAsync(query, { path: ['query'] })
          .catch(throwInvalidRequest)

        try {
          await server.revoke(tokenIdentification)
        } catch (err) {
          onError?.(req, res, err, 'Failed to revoke token')
        }

        // Same as POST + redirect to callback URL
        // todo: generate JSONP response (if "callback" is provided)

        throw new Error(
          'You are successfully logged out. Redirect not implemented',
        )
      }),
    )

    router.options('/oauth/introspect', corsPreflight)
    router.post(
      '/oauth/introspect',
      oauthHandler(async function (req, _res) {
        const payload = await parseHttpRequest(req, ['json', 'urlencoded'])

        const credentials = await oauthClientCredentialsSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidRequest)

        const tokenIdentification = await oauthTokenIdentificationSchema
          .parseAsync(payload, { path: ['body'] })
          .catch(throwInvalidRequest)

        return server.introspect(credentials, tokenIdentification)
      }),
    )

    //- Private authorization endpoints

    router.use(authorizeAssetsMiddleware())

    router.get(
      '/oauth/authorize',
      navigationHandler(async function (req, res) {
        validateFetchSite(req, res, ['cross-site', 'none'])

        const query = Object.fromEntries(this.url.searchParams)

        const clientCredentials = await oauthClientCredentialsSchema
          .parseAsync(query, { path: ['query'] })
          .catch(throwInvalidRequest)

        if ('client_secret' in clientCredentials) {
          throw new InvalidRequestError('Client secret must not be provided')
        }

        const authorizationRequest = await oauthAuthorizationRequestQuerySchema
          .parseAsync(query, { path: ['query'] })
          .catch(throwInvalidRequest)

        const { deviceId, deviceMetadata } = await server.deviceManager.load(
          req,
          res,
        )

        const result:
          | AuthorizationResultRedirect
          | AuthorizationResultAuthorize = await server
          .authorize(
            clientCredentials,
            authorizationRequest,
            deviceId,
            deviceMetadata,
          )
          .catch((err) => accessDeniedToRedirectCatcher(req, res, err))

        if ('redirect' in result) {
          return sendAuthorizeRedirect(res, result)
        } else {
          await setupCsrfToken(req, res, csrfCookie(result.authorize.uri))
          return server.outputManager.sendAuthorizePage(res, result, {
            preferredLocales: extractLocales(req),
          })
        }
      }),
    )

    router.post(
      '/oauth/authorize/verify-handle-availability',
      apiHandler(
        z.object({ handle: handleSchema }).strict(),
        async function (req, res, data) {
          await server.accountManager.verifyHandleAvailability(data.handle)
          return { available: true }
        },
      ),
    )

    router.post(
      '/oauth/authorize/sign-up',
      apiHandler(signUpInputSchema, async function (req, res, data, ctx) {
        return server.signUp(ctx, data)
      }),
    )

    router.post(
      '/oauth/authorize/sign-in',
      apiHandler(signInDataSchema, async function (req, res, data, ctx) {
        return server.signIn(ctx, data)
      }),
    )

    router.post(
      '/oauth/authorize/reset-password-request',
      apiHandler(
        resetPasswordRequestDataSchema,
        async function (req, res, data) {
          await server.accountManager.resetPasswordRequest(data)
          return { success: true }
        },
      ),
    )

    router.post(
      '/oauth/authorize/reset-password-confirm',
      apiHandler(
        resetPasswordConfirmDataSchema,
        async function (req, res, data) {
          await server.accountManager.resetPasswordConfirm(data)
          return { success: true }
        },
      ),
    )

    router.get(
      '/oauth/authorize/accept',
      authorizeRedirectNavigationHandler(async function (req, res, ctx) {
        const sub = this.url.searchParams.get('account_sub')
        if (!sub) throw new InvalidRequestError('Account sub not provided')

        return server
          .acceptRequest(ctx, sub)
          .catch((err) => accessDeniedToRedirectCatcher(req, res, err))
      }),
    )

    router.get(
      '/oauth/authorize/reject',
      authorizeRedirectNavigationHandler(async function (req, res, ctx) {
        return server
          .rejectRequest(ctx)
          .catch((err) => accessDeniedToRedirectCatcher(req, res, err))
      }),
    )

    return router
  }
}

function throwInvalidGrant(err: unknown): never {
  throw new InvalidGrantError(
    extractZodErrorMessage(err) || 'Invalid grant',
    err,
  )
}

function throwInvalidClient(err: unknown): never {
  throw new InvalidClientError(
    extractZodErrorMessage(err) || 'Client authentication failed',
    err,
  )
}

function throwInvalidRequest(err: unknown): never {
  throw new InvalidRequestError(
    extractZodErrorMessage(err) || 'Input validation error',
    err,
  )
}

function extractZodErrorMessage(err: unknown): string | undefined {
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    if (issue?.path.length) {
      // "part" will typically be "body" or "query"
      const [part, ...path] = issue.path
      return `Validation of "${path.join('.')}" ${part} parameter failed: ${issue.message}`
    }
  }

  return undefined
}
