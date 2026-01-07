
# MemoryUpdateRequest


## Properties

Name | Type
------------ | -------------
`title` | string
`content` | string

## Example

```typescript
import type { MemoryUpdateRequest } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "title": Primeira memória fora do domínio (v2),
  "content": Atualizada — HDUD está operando com versionamento.,
} satisfies MemoryUpdateRequest

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as MemoryUpdateRequest
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


