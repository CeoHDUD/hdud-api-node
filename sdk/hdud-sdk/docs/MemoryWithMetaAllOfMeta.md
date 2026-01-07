
# MemoryWithMetaAllOfMeta


## Properties

Name | Type
------------ | -------------
`canEdit` | boolean
`currentVersion` | number

## Example

```typescript
import type { MemoryWithMetaAllOfMeta } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "canEdit": true,
  "currentVersion": 1,
} satisfies MemoryWithMetaAllOfMeta

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as MemoryWithMetaAllOfMeta
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


