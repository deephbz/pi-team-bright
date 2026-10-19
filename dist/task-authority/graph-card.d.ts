import type { GraphTaskReadState } from "./graph-control";
import type { GraphTaskCard } from "./graph-control-schemas";
/** Project controller state into the public Task card. */
export declare function projectGraphTaskCards(controller: GraphTaskReadState): GraphTaskCard[];
