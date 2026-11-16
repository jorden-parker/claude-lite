export const IMAGE_READER = "image-reader";

export const IMAGE_READER_DESCRIPTION =
  "Reads an image file (screenshot, mock-up, diagram, photo) and describes it. You cannot read images yourself: give this agent the file path and what you need to know about the image.";

export const IMAGE_READER_PROMPT =
  "Read the image file you are given and answer the question about it. Describe layout, text, colors and visible defects precisely. Do not edit files.";

export const IMAGE_READER_HANDOFF = `You cannot read images yourself. To look at an image, give the ${IMAGE_READER} agent the image file path and what you need to know about it.`;
