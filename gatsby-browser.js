import { wrapPageElement } from "./src/common/preprocess";
import { reportClientErrors } from "./src/common/clientErrorReporter";

export { wrapPageElement };

export const onClientEntry = () => {
    reportClientErrors(window);
};
