# AuthorsApi

All URIs are relative to *http://localhost:4000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**authorsAuthorIdMemoriesGet**](AuthorsApi.md#authorsauthoridmemoriesget) | **GET** /authors/{author_id}/memories | List memories for an author (RBAC + ownership enforced) |
| [**authorsAuthorIdMemoriesPost**](AuthorsApi.md#authorsauthoridmemoriespost) | **POST** /authors/{author_id}/memories | Create a memory for an author (version 1; RBAC + ownership enforced) |



## authorsAuthorIdMemoriesGet

> Array&lt;Memory&gt; authorsAuthorIdMemoriesGet(authorId)

List memories for an author (RBAC + ownership enforced)

### Example

```ts
import {
  Configuration,
  AuthorsApi,
} from '@hdud/sdk';
import type { AuthorsAuthorIdMemoriesGetRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new AuthorsApi(config);

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
  AuthorsApi,
} from '@hdud/sdk';
import type { AuthorsAuthorIdMemoriesPostRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const config = new Configuration({ 
    // Configure HTTP bearer authorization: BearerAuth
    accessToken: "YOUR BEARER TOKEN",
  });
  const api = new AuthorsApi(config);

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

