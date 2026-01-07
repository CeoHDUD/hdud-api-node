# HealthApi

All URIs are relative to *http://localhost:4000*

| Method | HTTP request | Description |
|------------- | ------------- | -------------|
| [**healthGet**](HealthApi.md#healthget) | **GET** /health | Health check |



## healthGet

> HealthResponse healthGet()

Health check

### Example

```ts
import {
  Configuration,
  HealthApi,
} from '@hdud/sdk';
import type { HealthGetRequest } from '@hdud/sdk';

async function example() {
  console.log("🚀 Testing @hdud/sdk SDK...");
  const api = new HealthApi();

  try {
    const data = await api.healthGet();
    console.log(data);
  } catch (error) {
    console.error(error);
  }
}

// Run the test
example().catch(console.error);
```

### Parameters

This endpoint does not need any parameter.

### Return type

[**HealthResponse**](HealthResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: `application/json`


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
| **200** | OK |  -  |
| **500** | DB disconnected |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)

