
import {calculateTruthScore} from './truth-score.service.js';
import {rankTruthMemories} from './truth-memory-ranking.service.js';
export function selectTruthMemories(memories,candidate){
 const ranked=rankTruthMemories(memories.map(m=>calculateTruthScore(m,candidate)));
 return {
  selected:ranked.filter(x=>x.status==='KEEP'),
  optional:ranked.filter(x=>x.status==='OPTIONAL'),
  discarded:ranked.filter(x=>x.status==='DROP')
 };
}
