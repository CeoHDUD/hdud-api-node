# MemoriesApi

All URIs are relative to *http://localhost:4000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**authorsAuthorIdMemoriesGet**](MemoriesApi.md#authorsauthoridmemoriesget) | **GET** /authors/{author_id}/memories | List memories for an author (RBAC + ownership enforced) |
| [**authorsAuthorIdMemoriesPost**](MemoriesApi.md#authorsauthoridmemoriespost) | **POST** /authors/{author_id}/memories | Create a memory for an author (version 1; RBAC + ownership enforced) |
| [**memoriesMemoryIdGet**](MemoriesApi.md#memoriesmemoryidget) | **GET** /memories/{memory_id} | Get memory by id (RBAC + ownership enforced) |
| [**memoriesMemoryIdPut**](MemoriesApi.md#memoriesmemoryidput) | **PUT** /memories/{memory_id} | Update memory (creates a new version; RBAC + ownership enforced) |
| [**memoriesMemoryIdRollbackVersionPost**](MemoriesApi.md#memoriesmemoryidrollbackversionpost) | **POST** /memories/{memory_id}/rollback/{version} | Rollback memory to a previous version (creates a new version; RBAC + ownership enforced) |
| [**memoriesMemoryIdTimelineGet**](MemoriesApi.md#memoriesmemoryidtimelineget) | **GET** /memories/{memory_id}/timeline | Get consolidated timeline for a memory (RBAC + ownership enforced) |
| [**memoriesMemoryIdVersionsGet**](MemoriesApi.md#memoriesmemoryidversionsget) | **GET** /memories/{memory_id}/versions | Get ledger events (versions) for a memory (RBAC + ownership enforced) |



## authorsAuthorIdMemoriesGet

> Array&lt;Memory&gt; authorsAuthorIdMemoriesGet(authorId)

List memories for an author (RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { AuthorsAuthorIdMemoriesGetRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    authorId: 1,
  } satisfies AuthorsAuthorIdMemoriesGetRequest;

  try {
    const data = await api.authorsAuthorIdMemoriesGet(body);
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
| **authorId** | `number` |  | [Defaults to `undefined`] |

### Return type

[**Array&lt;Memory&gt;**](Memory.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | List of memories |  -  |
| **403** | Forbidden (ownership) |  -  |
| **500** | Server error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## authorsAuthorIdMemoriesPost

> Memory authorsAuthorIdMemoriesPost(authorId, memoryCreateRequest)

Create a memory for an author (version 1; RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { AuthorsAuthorIdMemoriesPostRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    authorId: 1,
    // MemoryCreateRequest
    memoryCreateRequest: ...,
  } satisfies AuthorsAuthorIdMemoriesPostRequest;

  try {
    const data = await api.authorsAuthorIdMemoriesPost(body);
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
| **authorId** | `number` |  | [Defaults to `undefined`] |
| **memoryCreateRequest** | [MemoryCreateRequest](MemoryCreateRequest.md) |  | |

### Return type

[**Memory**](Memory.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **201** | Created |  -  |
| **400** | Validation error |  -  |
| **403** | Forbidden (ownership) |  -  |
| **500** | Server error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## memoriesMemoryIdGet

> MemoryWithMeta memoriesMemoryIdGet(memoryId)

Get memory by id (RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { MemoriesMemoryIdGetRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    memoryId: 11,
  } satisfies MemoriesMemoryIdGetRequest;

  try {
    const data = await api.memoriesMemoryIdGet(body);
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
| **memoryId** | `number` |  | [Defaults to `undefined`] |

### Return type

[**MemoryWithMeta**](MemoryWithMeta.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Memory |  -  |
| **404** | Not found |  -  |
| **403** | Forbidden (ownership) |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## memoriesMemoryIdPut

> Memory memoriesMemoryIdPut(memoryId, memoryUpdateRequest)

Update memory (creates a new version; RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { MemoriesMemoryIdPutRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    memoryId: 11,
    // MemoryUpdateRequest
    memoryUpdateRequest: ...,
  } satisfies MemoriesMemoryIdPutRequest;

  try {
    const data = await api.memoriesMemoryIdPut(body);
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
| **memoryId** | `number` |  | [Defaults to `undefined`] |
| **memoryUpdateRequest** | [MemoryUpdateRequest](MemoryUpdateRequest.md) |  | |

### Return type

[**Memory**](Memory.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: `application/json`
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Updated (new version) |  -  |
| **400** | Validation error |  -  |
| **403** | Forbidden (ownership) |  -  |
| **404** | Not found |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## memoriesMemoryIdRollbackVersionPost

> RollbackResponse memoriesMemoryIdRollbackVersionPost(memoryId, version)

Rollback memory to a previous version (creates a new version; RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { MemoriesMemoryIdRollbackVersionPostRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    memoryId: 11,
    // number
    version: 1,
  } satisfies MemoriesMemoryIdRollbackVersionPostRequest;

  try {
    const data = await api.memoriesMemoryIdRollbackVersionPost(body);
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
| **memoryId** | `number` |  | [Defaults to `undefined`] |
| **version** | `number` |  | [Defaults to `undefined`] |

### Return type

[**RollbackResponse**](RollbackResponse.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Rollback OK |  -  |
| **404** | Version or memory not found |  -  |
| **403** | Forbidden (ownership) |  -  |
| **500** | Server error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## memoriesMemoryIdTimelineGet

> TimelineResponse memoriesMemoryIdTimelineGet(memoryId)

Get consolidated timeline for a memory (RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { MemoriesMemoryIdTimelineGetRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    memoryId: 11,
  } satisfies MemoriesMemoryIdTimelineGetRequest;

  try {
    const data = await api.memoriesMemoryIdTimelineGet(body);
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
| **memoryId** | `number` |  | [Defaults to `undefined`] |

### Return type

[**TimelineResponse**](TimelineResponse.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Timeline |  -  |
| **403** | Forbidden (ownership) |  -  |
| **500** | Server error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


## memoriesMemoryIdVersionsGet

> Array&lt;LedgerEvent&gt; memoriesMemoryIdVersionsGet(memoryId)

Get ledger events (versions) for a memory (RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  MemoriesApi,
} from '@hdud/sdk';
import type { MemoriesMemoryIdVersionsGetRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new MemoriesApi(config);

  const body = {
    // number
    memoryId: 11,
  } satisfies MemoriesMemoryIdVersionsGetRequest;

  try {
    const data = await api.memoriesMemoryIdVersionsGet(body);
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
| **memoryId** | `number` |  | [Defaults to `undefined`] |

### Return type

[**Array&lt;LedgerEvent&gt;**](LedgerEvent.md)

### Authorization

[BearerAuth](../README.md#BearerAuth)

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | Ledger events |  -  |
| **403** | Forbidden (ownership) |  -  |
| **500** | Server error |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

