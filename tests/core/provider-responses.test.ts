import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NativeResponseAssembly } from '../../src/providers/transport/response-assembly.ts';
import { EventDecoder } from '../../src/providers/transport/response-http.ts';
import type { StreamEvent } from '../../src/protocol/open-responses/index.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Provider standard Responses boundary', () => {
  it('assembles a native reasoning Item from its deltas and replays them as events',()=>{
    const assembly=new NativeResponseAssembly();const events:StreamEvent[]=[];
    const initial={id:'r-native',model:'test',status:'in_progress',output:[]};
    const item={id:'reason',type:'reasoning',status:'completed',summary:[],content:[{type:'reasoning_text',text:'checked'}]};
    const native=[
      {type:'response.created',response:initial},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.content_part.added',output_index:0,item_id:'reason',content_index:0,part:{type:'reasoning_text',text:''}},
      {type:'response.reasoning.delta',output_index:0,item_id:'reason',content_index:0,delta:'checked'},
      {type:'response.reasoning.done',output_index:0,item_id:'reason',content_index:0,text:'checked'},
      {type:'response.content_part.done',output_index:0,item_id:'reason',content_index:0,part:item.content[0]},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{...initial,status:'completed',output:[item]}},
    ];
    native.forEach((event,sequence_number)=>assembly.feed({...event,sequence_number},event=>events.push(event)));
    expect(assembly.finish().output).toEqual([item]);
    expect(events.map(event=>event.type)).toContain('response.reasoning.delta');
  });

  it('decodes real native Responses framing and retains encrypted reasoning and function identity', () => {
    const raw = readFileSync(new URL('../fixtures/responses-stream.sse', import.meta.url), 'utf8');
    const decoder = new EventDecoder();
    const assembly = new NativeResponseAssembly();
    for (let index = 0; index < raw.length; index += 17) {
      for (const payload of decoder.feed(raw.slice(index, index + 17))) {
        if (payload !== '[DONE]') assembly.feed(JSON.parse(payload), () => {});
      }
    }
    const response = assembly.finish();
    expect(response.status).toBe('completed');
    expect(response.output[0]).toMatchObject({ type: 'reasoning', encrypted_content: expect.any(String) });
    expect(response.output[1]).toMatchObject({ type: 'function_call', id: expect.any(String), call_id: expect.any(String) });
    expect(response.output.filter(item => item.type === 'function_call')).toHaveLength(1);
    expect(assembly.meters().native).toHaveProperty('input_tokens');
  });
});
