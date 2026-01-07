
# TimelineResponse


## Properties

Name | Type
------------ | -------------
`memoryId` | number
`totalVersions` | number
`timeline` | Array&lt;object&gt;

## Example

```typescript
import type { TimelineResponse } from '@hdud/sdk'

// TODO: Update the object below with actual values
const example = {
  "memoryId": 11,
  "totalVersions": 4,
  "timeline": null,
} satisfies TimelineResponse

console.log(example)

// Convert the instance to a JSON string
const exampleJSON: string = JSON.stringify(example)
console.log(exampleJSON)

// Parse the JSON string back to an object
const exampleParsed = JSON.parse(exampleJSON) as TimelineResponse
console.log(exampleParsed)
```

[[Back to top]](#) [[Back to API list]](../README.md#api-endpoints) [[Back to Model list]](../README.md#models) [[Back to README]](../README.md)


