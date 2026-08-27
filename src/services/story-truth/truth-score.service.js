
export function calculateTruthScore(memory,candidate){
 let score=0,reasons=[];
 if(candidate?.memoryIds?.includes(memory.memory_id)){score+=30;reasons.push('story_candidate');}
 if(memory.title){score+=10;reasons.push('title');}
 if(/\b(18|19|20|21)\d{2}\b/.test(memory.content||'')){score+=25;reasons.push('temporal_evidence');}
 if((memory.content||'').length>300){score+=15;reasons.push('rich_content');}
 const status=score>=70?'KEEP':score>=50?'OPTIONAL':'DROP';
 return {memory_id:memory.memory_id,truth_score:score,status,reasons};
}
