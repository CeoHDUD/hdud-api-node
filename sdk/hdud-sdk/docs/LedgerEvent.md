
# LedgerEvent


## Properties

Name | Type
------------ | -------------
`ledgerId` | string
`eventType` | string
`entityType` | string
`entityId` | string
`versionNumber` | number
`createdAt` | Date
`createdBy` | string
`payload` | object

## Example

```typescript
import type { LedgerEvent } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "ledgerId": 27,
  "eventType": MEMORY_UPDATED,
  "entityType": MEMORY,
  "entityId": 11,
  "versionNumber": 2,
  "createdAt": null,
  "createdBy": hdud_api_v0.1,
  "payload": null,
} satisfies LedgerEvent

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as LedgerEvent
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


