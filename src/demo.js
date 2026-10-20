// Fictional responses for offline demonstrations and adapter integration tests.
// No fixture contains real family data or contacts.
const base='/family/bookings/edit';
const contextHtml='<div><button class="dropdown-toggle">Sample Primary School</button><a href="'+base+'?careType=10">After School Care</a><a href="'+base+'?careType=11">Before School Care</a></div>';
const dashboard='<table><tr><td>Maya Sample</td><td><a href="/family/child/1/edit">Update Child</a></td></tr><tr><td>Alex Sample</td><td><a href="/family/child/2/edit">Update Child</a></td></tr></table>';
export const fixtureConditions='After School Care 3:30pm–6:30pm. Sample fee $27.20 before CCS. Sample late booking and cancellation conditions apply.';
export function calendarFixture({year=2026,child='1',care='10',saved={}}={}) {
  const cells=[];
  for(let month=0;month<12;month++) for(let day=1;day<=31;day++) {
    const date=new Date(Date.UTC(year,month,day));
    if(date.getUTCMonth()!==month||[0,6].includes(date.getUTCDay())) continue;
    const iso=date.toISOString().slice(0,10), dmy=iso.split('-').reverse().join('-');
    const status=saved[iso]||'', classes=status==='BOOKED'?'booked savedBooking allowCancel':status==='AWAITING_BOOKING'?'waitlistBooked allowCancel':'available';
    cells.push('<td class="changeable '+classes+'" data-fb-date="'+dmy+'" data-original-value="'+status+'" data-display-date="'+iso+'"><input type="hidden" name="bookings['+dmy+'].bookingStatus" value="'+status+'">'+day+'</td>');
  }
  return contextHtml+'<form id="entityForm" method="post" action="'+base+'"><input name="_csrf" value="sample-csrf"><input name="_requestToken" value="sample-token"><input name="childcareService" value="3"><input name="child" value="'+child+'"><input name="careType" value="'+care+'"><input name="year" value="'+year+'"><button class="dropdown-toggle">Sample Primary School</button><div id="bookingMessageBlock">'+fixtureConditions+'</div><table id="multimonth">'+cells.join('')+'</table><button name="action" value="submitCal">Next</button></form>';
}
export function reviewFixture(plan,{extra='',child='1',care='10',year=2026}={}) {
  return '<form id="entityForm" method="post" action="'+base+'"><input name="_csrf" value="sample-csrf"><input name="_requestToken" value="sample-token"><input name="child" value="'+child+'"><input name="careType" value="'+care+'"><input name="childcareService" value="3"><input name="year" value="'+year+'">'+plan.map(c=>'<input name="bookings[&#39;'+c.date.split('-').reverse().join('-')+'&#39;].bookingStatus" value="'+c.status+'">').join('')+'<table><tr><td>'+plan.map(c=>c.date+' '+c.status).join('; ')+'</td></tr></table><div id="cancellationPolicyCard">Sample cancellation policy. More than 2 days: no charge.</div><div id="bookingTermsCard">Sample terms. This is fictional sample data.'+extra+'</div><input type="checkbox" name="optinBookingConfirmation" value="true"><button name="action" value="submitConfirm">Confirm Changes</button></form>';
}
export function demoFetch({allowSave=false,referenceDate='2026-10-20'}={}) {
  const saved={};
  for(let offset=1;Object.keys(saved).length<3;offset++) {
    const d=new Date(Date.parse(referenceDate+'T00:00:00Z')+offset*86400000);
    if([2,5].includes(d.getUTCDay()))saved[d.toISOString().slice(0,10)]='BOOKED';
  }
  return async(url,opts={})=>{
    const u=new URL(url),fields=new URLSearchParams(opts.body);
    if(u.pathname==='/family/dashboard') return new Response(dashboard);
    if(u.pathname==='/family/portlet/bookings.json') {
      const events=Object.entries(saved).filter(([,s])=>s==='BOOKED').flatMap(([date])=>['Maya','Alex'].map((name,i)=>({id:date+'-'+i,title:'After School Care: '+name,start:date+'T15:30:00+11:00',end:date+'T18:30:00+11:00'})));
      return Response.json(events);
    }
    if(u.pathname===base) {
      if(opts.method==='POST') {
        const plan=[...fields].filter(([k,v])=>k.startsWith('bookings[')&&v).map(([name,status])=>({date:name.match(/\d{2}-\d{2}-\d{4}/)[0].split('-').reverse().join('-'),status})).filter(c=>c.status!==(saved[c.date]||''));
        if(fields.get('action')==='submitCal') return new Response(reviewFixture(plan,{child:fields.get('child'),care:fields.get('careType'),year:fields.get('year')}));
        if(fields.get('action')==='submitConfirm') {
          if(!allowSave) return new Response('Sample mode cannot save',{status:403});
          for(const p of plan) saved[p.date]=p.status;
          return new Response('<div>Changes saved</div>');
        }
      }
      if(u.searchParams.get('child')) return new Response(calendarFixture({year:Number(u.searchParams.get('year')),child:u.searchParams.get('child'),care:u.searchParams.get('careType'),saved}));
      return new Response(contextHtml);
    }
    return new Response('Not found',{status:404});
  };
}
