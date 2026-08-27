
export function buildTruthSelectionReport(r){
 return {statistics:{total:r.selected.length+r.optional.length+r.discarded.length,keep:r.selected.length,optional:r.optional.length,drop:r.discarded.length},...r};
}
