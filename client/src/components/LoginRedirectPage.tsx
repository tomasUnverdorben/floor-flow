import {Navigate, useLocation, useSearchParams} from "react-router-dom";

const getToken = async (sessionState, code) => {
    return fetch('http://localhost:8080/realms/floorflow/protocol/openid-connect/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'sec-fetch-site': 'cross-site',
        },
        credentials: 'include',
        body: `code=${code}&client_id=floorflow&grant_type=authorization_code&redirect_uri=http://localhost:5173/login`,
        referrerPolicy: 'origin',
    })
    .then(res => {
        if (res.status == 200) {
            return res.json()
        } else {
            throw new Error(`${res.status}: ${JSON.stringify(res.json())}`)
        }
    })
    .then(json => {
        console.log(JSON.stringify(json));
        localStorage.setItem('jwt', json.access_token);
    })
    .catch(err => console.log('error getting token: ' + err));
}

const LoginRedirectPage = () => {
    if (localStorage.getItem('jwt')) {
        return (
            <Navigate to={"/"}/>
        );
    };

    const [searchParams, ] = useSearchParams();
    const sessionState = searchParams.get("session_state");
    const code = searchParams.get("code");
    getToken(sessionState, code);

    return (
        <div>
            <p>Login Successful!!1</p><br/>
            <p>Token: { localStorage.getItem("jwt") }</p>
        </div>
    )
}

export default LoginRedirectPage;

