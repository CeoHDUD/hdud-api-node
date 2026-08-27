export const rankTruthMemories=(a)=>[...a].sort((x,y)=>y.truth_score-x.truth_score);
