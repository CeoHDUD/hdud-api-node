# AuthApi

All URIs are relative to *http://localhost:4000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**authLoginPost**](AuthApi.md#authloginpost) | **POST** /auth/login | Login (returns JWT tokens) |
| [**authSignupPost**](AuthApi.md#authsignuppost) | **POST** /auth/signup | Sign up (creates user + optionally links/creates author) |



## authLoginPost

> AuthLoginResponse authLoginPost(authLoginRequest)

Login (returns JWT tokens)

### Example

```ts
import {
  Configuration,
  AuthApi,
} from '@hdud/sdk';
import type { AuthLoginPostRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const api = new AuthApi();

  const body = {
    // AuthLoginRequest
    authLoginRequest: ...,
  } satisfies AuthLoginPostRequest;

  try {
    const data = await api.authLoginPost(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **authLoginRequest** | [AuthLoginRequest](AuthLoginRequest.md) |  | |

### Return type

[**AuthLoginResponse**](AuthLoginResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |
| **401** | Invalid credentials |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## authSignupPost

> AuthSignupResponse authSignupPost(authSignupRequest)

Sign up (creates user + optionally links/creates author)

### Example

```ts
import {
  Configuration,
  AuthApi,
} from '@hdud/sdk';
import type { AuthSignupPostRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const api = new AuthApi();

  const body = {
    // AuthSignupRequest
    authSignupRequest: ...,
  } satisfies AuthSignupPostRequest;

  try {
    const data = await api.authSignupPost(body);
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters


| Name | Type | Description  | Notes |
|------------- | ------------- | ------------- | -------------|
| **authSignupRequest** | [AuthSignupRequest](AuthSignupRequest.md) |  | |

### Return type

[**AuthSignupResponse**](AuthSignupResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | Created |  -  |
| **400** | Validation error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

