// Source: https://ui.shadcn.com/r/styles/new-york-v4/collapsible.json
function Collapsible({ ...props }: React.ComponentProps<"details">) {
  return <details data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: React.ComponentProps<"summary">) {
  return <summary data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ ...props }: React.ComponentProps<"div">) {
  return <div data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
