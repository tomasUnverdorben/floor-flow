import {useEffect} from "react";

const NavigateExternal = ({ url }) => {
    useEffect(() => {
        window.location.href = url;
    }, []);
    return null;
};

const PrivateRoute = ({children}) => {
    const authenticate = !!localStorage.getItem('jwt');
    const encodedRedirect = "http://localhost:5173/login";
    const clientId = "floorflow";

    return authenticate ? (
        children
    ) : (
        <NavigateExternal url={`http://localhost:8080/realms/floorflow/protocol/openid-connect/auth?redirect_uri=${encodedRedirect}&client_id=${clientId}&client_secret=&response_type=code`}></NavigateExternal>
    )
}

export default PrivateRoute;
